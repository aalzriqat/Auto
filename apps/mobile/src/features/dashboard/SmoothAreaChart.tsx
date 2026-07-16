import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";

type Point = { x: number; y: number };

function buildSmoothPath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x},${points[0].y}`;

  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
}

export function SmoothAreaChart({
  values,
  width,
  height,
  color,
}: Readonly<{ values: readonly number[]; width: number; height: number; color: string }>) {
  const safeValues = values.length > 0 ? values : [0];
  const maxValue = Math.max(...safeValues, 1);
  const topPadding = 10;
  const bottomPadding = 6;
  const usableHeight = height - topPadding - bottomPadding;

  const points: Point[] = safeValues.map((value, index) => {
    const x = safeValues.length > 1 ? (index / (safeValues.length - 1)) * width : width;
    const normalized = Math.max(0, value) / maxValue;
    const y = topPadding + (1 - normalized) * usableHeight;
    return { x, y };
  });

  const linePath = buildSmoothPath(points);
  const areaPath = `${linePath} L ${width},${height} L 0,${height} Z`;
  const lastPoint = points[points.length - 1];

  return (
    <Svg height={height} width={width}>
      <Defs>
        <LinearGradient id="areaGradient" x1="0" x2="0" y1="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={0.25} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={areaPath} fill="url(#areaGradient)" />
      <Path d={linePath} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} />
      {lastPoint ? <Circle cx={lastPoint.x} cy={lastPoint.y} fill={color} r={4.5} /> : null}
    </Svg>
  );
}
