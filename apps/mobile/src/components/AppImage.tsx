import { Component, useState, type ReactNode } from "react";
import {
  Image as RNImage,
  StyleSheet,
  View,
  type ImageStyle,
  type StyleProp,
} from "react-native";

import { useThemedStyles } from "../providers/ThemeProvider";
import { type AppTheme } from "../theme";

type ExpoImageComponent = React.ComponentType<{
  accessibilityLabel?: string;
  cachePolicy?: string;
  contentFit?: string;
  onError?: () => void;
  onLoadEnd?: () => void;
  source?: { uri: string };
  style?: StyleProp<ImageStyle>;
  testID?: string;
  transition?: number;
}>;

let cachedExpoImage: ExpoImageComponent | null | undefined;

/**
 * expo-image is a NATIVE module. An OTA update can ship this JavaScript to a
 * binary that predates it, and in that build importing it throws where the
 * native view would be registered. Resolve it lazily, once, and treat a failure
 * as "not available" rather than letting it take the screen down.
 */
export function resolveExpoImage(): ExpoImageComponent | null {
  if (cachedExpoImage !== undefined) {
    return cachedExpoImage;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("expo-image") as { Image?: ExpoImageComponent };
    cachedExpoImage = module?.Image ?? null;
  } catch (error) {
    console.error("expo-image is unavailable in this build", error);
    cachedExpoImage = null;
  }

  return cachedExpoImage;
}

/** Test seam: forget the resolved component. */
export function resetExpoImageCache() {
  cachedExpoImage = undefined;
}

type ImageFallbackBoundaryProps = Readonly<{
  children: ReactNode;
  fallback: ReactNode;
}>;

/**
 * Second line of defence. The module can import cleanly and still fail when the
 * native VIEW is missing, which surfaces as a render-time throw — exactly the
 * shape an error boundary exists for. Without this, an older binary receiving
 * this OTA would white-screen instead of showing a plain image.
 */
class ImageFallbackBoundary extends Component<
  ImageFallbackBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Falling back to the platform image renderer", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export type AppImageProps = Readonly<{
  accessibilityLabel?: string;
  contentFit?: "cover" | "contain";
  /** Called when the image fails to load, after the placeholder is restored. */
  onError?: () => void;
  style?: StyleProp<ImageStyle>;
  testID?: string;
  uri?: string;
}>;

/**
 * The app's remote image. Raw <Image> had no placeholder, no error handling and
 * no caching: a slow network left a blank rectangle, and a dead URL left that
 * rectangle blank forever with no way to tell the two apart.
 *
 * Renders a tinted placeholder underneath until the image resolves, keeps it in
 * place if the load fails, and degrades to the platform renderer wherever
 * expo-image is not available.
 */
export function AppImage({
  accessibilityLabel,
  contentFit = "cover",
  onError,
  style,
  testID,
  uri,
}: AppImageProps) {
  const styles = useThemedStyles(makeStyles);
  const [settled, setSettled] = useState(false);
  const [failed, setFailed] = useState(false);
  const ExpoImage = resolveExpoImage();

  function handleError() {
    setFailed(true);
    setSettled(true);
    onError?.();
  }

  if (!uri) {
    return <View style={[styles.placeholder, style]} testID={testID} />;
  }

  const platformImage = (
    <RNImage
      accessibilityLabel={accessibilityLabel}
      onError={handleError}
      onLoadEnd={() => setSettled(true)}
      resizeMode={contentFit}
      source={{ uri }}
      style={styles.image}
      testID={testID}
    />
  );

  // `style` sizes the ROOT only; both layers fill it. Passing the caller's
  // width/height down to an absolutely-filled child would fight the fill.
  return (
    <View style={[styles.root, style]}>
      {settled && !failed ? null : <View style={styles.placeholder} testID={testID ? `${testID}-placeholder` : undefined} />}
      {failed ? null : (
        <ImageFallbackBoundary fallback={platformImage}>
          {ExpoImage ? (
            <ExpoImage
              accessibilityLabel={accessibilityLabel}
              cachePolicy="memory-disk"
              contentFit={contentFit}
              onError={handleError}
              onLoadEnd={() => setSettled(true)}
              source={{ uri }}
              style={styles.image}
              testID={testID}
              transition={180}
            />
          ) : (
            platformImage
          )}
        </ImageFallbackBoundary>
      )}
    </View>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  root: {
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceAlt,
  },
  image: {
    // Spelled out rather than StyleSheet.absoluteFillObject: the mobile
    // package's TypeScript config does not expose that helper on StyleSheet.
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  placeholder: {
    // Spelled out rather than StyleSheet.absoluteFillObject: the mobile
    // package's TypeScript config does not expose that helper on StyleSheet.
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.surfaceAlt,
  },
});
