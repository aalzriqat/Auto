import type { Locale, MobileFoundationStringKey } from "@autoflow/shared";
import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { getMobileEnv } from "../../config/env";
import { theme } from "../../theme";
import { useLocale } from "../../providers/LocaleProvider";
import { parseTurnstileMessage } from "./marketplaceUtils";

type VerificationStatus = "loading" | "complete" | "expired" | "error";

interface TurnstileVerificationProps {
  siteKey?: string;
  onTokenChange: (token: string | null) => void;
  resetKey: number;
}

const TURNSTILE_ACTION = "turnstile-spin-v1";
const DEFAULT_BASE_URL = "https://www.autoflowdealer.com/";

function serializeScriptString(value: string): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

function getTurnstileBaseUrl(): string {
  try {
    return getMobileEnv().appUrl || DEFAULT_BASE_URL;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function buildTurnstileHtml(siteKey: string, locale: Locale): string {
  const language = locale === "ar" ? "ar" : "en";
  const serializedSiteKey = serializeScriptString(siteKey);
  const serializedAction = serializeScriptString(TURNSTILE_ACTION);
  const serializedLanguage = serializeScriptString(language);

  return `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        min-height: 90px;
        background: transparent;
        overflow: hidden;
        color-scheme: light;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #turnstile-widget {
        min-height: 70px;
      }
    </style>
  </head>
  <body>
    <div id="turnstile-widget"></div>
    <script>
      (function () {
        var attempts = 0;
        function post(payload) {
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify(payload));
          }
        }
        function renderWidget() {
          attempts += 1;
          if (!window.turnstile) {
            if (attempts < 40) {
              window.setTimeout(renderWidget, 150);
            } else {
              post({ type: "error", code: "load-timeout" });
            }
            return;
          }
          window.turnstile.render("#turnstile-widget", {
            sitekey: ${serializedSiteKey},
            action: ${serializedAction},
            language: ${serializedLanguage},
            theme: "light",
            callback: function (token) {
              post({ type: "token", token: token });
            },
            "expired-callback": function () {
              post({ type: "expired" });
            },
            "error-callback": function (code) {
              post({ type: "error", code: String(code || "") });
            }
          });
        }
        renderWidget();
      })();
    </script>
  </body>
</html>`;
}

function statusKey(status: VerificationStatus): MobileFoundationStringKey {
  switch (status) {
    case "complete":
      return "marketplaceVerificationComplete";
    case "expired":
      return "marketplaceVerificationExpired";
    case "error":
      return "marketplaceVerificationFailed";
    case "loading":
      return "marketplaceVerificationLoading";
  }
}

export function TurnstileVerification({ siteKey, onTokenChange, resetKey }: TurnstileVerificationProps) {
  const { locale, t, textDirection } = useLocale();
  const [status, setStatus] = useState<VerificationStatus>("loading");
  const html = useMemo(() => (siteKey ? buildTurnstileHtml(siteKey, locale) : ""), [locale, siteKey]);
  const baseUrl = useMemo(() => getTurnstileBaseUrl(), []);

  function receiveTurnstileMessage(event: WebViewMessageEvent) {
    const message = parseTurnstileMessage(event.nativeEvent.data);
    if (!message) return;

    if (message.type === "token") {
      setStatus("complete");
      onTokenChange(message.token);
      return;
    }

    setStatus(message.type === "expired" ? "expired" : "error");
    onTokenChange(null);
  }

  if (!siteKey) {
    return (
      <View style={[styles.notice, { direction: textDirection }]}>
        <Text style={styles.noticeText}>{t("marketplaceVerificationMissing")}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrapper, { direction: textDirection }]}>
      <WebView
        key={`${resetKey}-${locale}`}
        source={{ html, baseUrl }}
        originWhitelist={["https://*", "about:blank", "about:srcdoc"]}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        onMessage={receiveTurnstileMessage}
        onLoadStart={() => {
          setStatus("loading");
          onTokenChange(null);
        }}
        onError={() => {
          setStatus("error");
          onTokenChange(null);
        }}
        style={styles.webview}
        scrollEnabled={false}
        automaticallyAdjustContentInsets={false}
      />
      <Text style={[styles.statusText, status === "complete" && styles.statusComplete]}>
        {t(statusKey(status))}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: theme.spacing.xs,
  },
  webview: {
    height: 92,
    overflow: "hidden",
    backgroundColor: "transparent",
  },
  statusText: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "700",
  },
  statusComplete: {
    color: theme.colors.success,
  },
  notice: {
    borderRadius: theme.radius.sm,
    backgroundColor: "#fef3c7",
    padding: theme.spacing.md,
  },
  noticeText: {
    color: theme.colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
});
