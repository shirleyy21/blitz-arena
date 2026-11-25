import { useEffect, useRef } from "react";
import { PositionSide, TradeMarker } from "../lib/arenaEngine";

interface ArenaChartProps {
  price: number | null;
  entryPrice: number | null;
  positionSide: PositionSide;
  leverage: number;
  liquidationPrice: number | null;
  markers: TradeMarker[];
}

interface SamplePoint {
  t: number;
  v: number;
}

interface AxisRange {
  min: number;
  max: number;
}

const WINDOW_MS = 25_000;
const RENDER_DELAY_MS = 220;
const MAX_POINTS = 1500;
const LEFT_PAD = 72;
const RIGHT_PAD = 72;
const TOP_PAD = 22;
const BOTTOM_PAD = 26;
const CURVE_TENSION = 0.2;
const AXIS_EASE = 5.5;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export default function ArenaChart({
  price,
  entryPrice,
  positionSide,
  leverage,
  liquidationPrice,
  markers,
}: ArenaChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const seriesRef = useRef<SamplePoint[]>([]);
  const currentAxisRef = useRef<AxisRange | null>(null);
  const lastPriceRef = useRef<number | null>(null);
  const propsRef = useRef({
    entryPrice,
    positionSide,
    leverage,
    liquidationPrice,
    markers,
  });

  propsRef.current = {
    entryPrice,
    positionSide,
    leverage,
    liquidationPrice,
    markers,
  };

  useEffect(() => {
    if (price == null || !Number.isFinite(price)) return;
    const now = Date.now();
    const series = seriesRef.current;
    const prev = series[series.length - 1];
    if (prev && now - prev.t > 240) {
      series.push({ t: now - 240, v: prev.v });
    }
    if (!prev || Math.abs(prev.v - price) > 1e-9 || now - prev.t > 450) {
      series.push({ t: now, v: price });
    }
    const cutoff = now - WINDOW_MS * 3;
    while (series.length > 2 && series[0].t < cutoff) series.shift();
    if (series.length > MAX_POINTS) {
      series.splice(0, series.length - MAX_POINTS);
    }
    lastPriceRef.current = price;
  }, [price]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = Math.max(270, container.clientHeight);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let rafId = 0;
    let lastTs = performance.now();

    const interpolateAt = (timestamp: number): number | null => {
      const s = seriesRef.current;
      if (!s.length) return null;
      if (s.length === 1 || timestamp <= s[0].t) return s[0].v;
      const last = s[s.length - 1];
      if (timestamp >= last.t) return last.v;
      let lo = 0;
      let hi = s.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s[mid].t < timestamp) lo = mid + 1;
        else hi = mid;
      }
      const cur = s[lo];
      const prv = s[Math.max(0, lo - 1)];
      const span = cur.t - prv.t;
      const t = span <= 0 ? 1 : (timestamp - prv.t) / span;
      return lerp(prv.v, cur.v, t);
    };

    const frame = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        rafId = requestAnimationFrame(frame);
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        rafId = requestAnimationFrame(frame);
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const now = Date.now();
      const visualNow = now - RENDER_DELAY_MS;
      const perfNow = performance.now();
      const dt = Math.min(0.05, (perfNow - lastTs) / 1000);
      lastTs = perfNow;

      const s = seriesRef.current;
      if (!s.length) {
        ctx.fillStyle = "#6e829c";
        ctx.font = "500 13px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(
          "Connecting to MagicBlock SOL/USD Ephemeral Oracle…",
          w / 2,
          h / 2,
        );
        rafId = requestAnimationFrame(frame);
        return;
      }

      const latestVal = interpolateAt(visualNow) ?? lastPriceRef.current ?? s[s.length - 1].v;
      const {
        entryPrice: ent,
        positionSide: side,
        leverage: lev,
        liquidationPrice: liq,
        markers: tradeMarkers,
      } = propsRef.current;

      const visible = s.filter((p) => p.t >= visualNow - WINDOW_MS && p.t <= visualNow);
      const vals = visible.length ? visible.map((p) => p.v) : [latestVal];
      if (ent && side !== "flat") vals.push(ent);

      const minV = Math.min(latestVal, ...vals);
      const maxV = Math.max(latestVal, ...vals);
      const minSpan = Math.max(latestVal * 0.0008, 0.02);
      const span = Math.max(minSpan, (maxV - minV) * 1.65);
      const center = (minV + maxV) / 2;
      const targetRange: AxisRange = {
        min: center - span / 2,
        max: center + span / 2,
      };

      if (!currentAxisRef.current) {
        currentAxisRef.current = targetRange;
      } else {
        const k = 1 - Math.exp(-AXIS_EASE * dt);
        currentAxisRef.current = {
          min: lerp(currentAxisRef.current.min, targetRange.min, k),
          max: lerp(currentAxisRef.current.max, targetRange.max, k),
        };
      }

      const range = currentAxisRef.current;
      const plotRight = Math.max(LEFT_PAD + 10, w - RIGHT_PAD);
      const plotW = plotRight - LEFT_PAD;
      const plotTop = TOP_PAD;
      const plotBottom = h - BOTTOM_PAD;
      const plotH = Math.max(10, plotBottom - plotTop);

      const timeToX = (t: number) =>
        LEFT_PAD + ((t - (visualNow - WINDOW_MS)) / WINDOW_MS) * plotW;
      const valToY = (v: number) => {
        const clamped = Math.max(range.min, Math.min(range.max, v));
        return plotBottom - ((clamped - range.min) / (range.max - range.min)) * plotH;
      };

      // Horizontal price grid
      const tickCount = 5;
      ctx.save();
      ctx.strokeStyle = "rgba(130, 165, 210, 0.09)";
      ctx.fillStyle = "#697e99";
      ctx.font = "500 11px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= tickCount; i += 1) {
        const val = range.min + ((range.max - range.min) * i) / tickCount;
        const y = valToY(val);
        ctx.beginPath();
        ctx.moveTo(LEFT_PAD, y);
        ctx.lineTo(plotRight, y);
        ctx.stroke();
        ctx.fillText(`$${val.toFixed(3)}`, 8, y);
      }

      // Vertical 5-second time grid
      const leftT = visualNow - WINDOW_MS;
      const firstGrid = Math.floor(leftT / 5000) * 5000;
      for (let t = firstGrid; t <= visualNow + 5000; t += 5000) {
        const x = timeToX(t);
        if (x < LEFT_PAD || x > plotRight) continue;
        ctx.beginPath();
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
      }
      ctx.restore();

      // Determine PnL status for chart theme
      const inPosition = side !== "flat" && ent != null && ent > 0;
      const isProfit =
        inPosition &&
        (side === "long" ? latestVal >= ent! : latestVal <= ent!);

      // Entry zone ribbon + entry price dashed line
      if (inPosition && ent) {
        const entryY = valToY(ent);
        const curY = valToY(latestVal);
        const topY = Math.min(entryY, curY);
        const zoneH = Math.abs(curY - entryY);
        ctx.save();
        ctx.fillStyle = isProfit
          ? "rgba(16, 232, 152, 0.12)"
          : "rgba(255, 74, 114, 0.14)";
        ctx.fillRect(LEFT_PAD, topY, plotW, zoneH);

        ctx.strokeStyle = isProfit ? "#10e898" : "#ff4a72";
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(LEFT_PAD, entryY);
        ctx.lineTo(plotRight, entryY);
        ctx.stroke();

        // Entry label badge
        ctx.setLineDash([]);
        const label = `${side.toUpperCase()} ${lev}x @ $${ent.toFixed(3)}`;
        ctx.font = "700 10px 'JetBrains Mono', monospace";
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = isProfit
          ? "rgba(16, 232, 152, 0.22)"
          : "rgba(255, 74, 114, 0.24)";
        ctx.fillRect(LEFT_PAD + 8, entryY - 22, tw, 18);
        ctx.fillStyle = isProfit ? "#74ffca" : "#ff94ab";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, LEFT_PAD + 14, entryY - 13);
        ctx.restore();
      }

      // Liquidation warning line if visible inside chart range
      if (inPosition && liq && liq >= range.min && liq <= range.max) {
        const liqY = valToY(liq);
        ctx.save();
        ctx.strokeStyle = "rgba(255, 82, 82, 0.72)";
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(LEFT_PAD, liqY);
        ctx.lineTo(plotRight, liqY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#ff6b81";
        ctx.font = "700 10px 'JetBrains Mono', monospace";
        ctx.fillText(`LIQ $${liq.toFixed(3)}`, LEFT_PAD + 8, liqY - 8);
        ctx.restore();
      }

      // Build smooth price polyline
      const pts: { x: number; y: number }[] = [];
      const firstIdx = s.findIndex((p) => p.t >= leftT);
      if (firstIdx > 0) {
        const lv = interpolateAt(leftT);
        if (lv != null) pts.push({ x: LEFT_PAD, y: valToY(lv) });
      }
      const startIdx = firstIdx === -1 ? Math.max(0, s.length - 1) : firstIdx;
      for (let i = startIdx; i < s.length; i += 1) {
        const p = s[i];
        if (p.t > visualNow) break;
        const x = timeToX(p.t);
        if (x >= LEFT_PAD && x <= plotRight) {
          pts.push({ x, y: valToY(p.v) });
        }
      }
      const headPt = { x: plotRight, y: valToY(latestVal) };
      if (!pts.length || Math.abs(pts[pts.length - 1].x - headPt.x) > 1) {
        pts.push(headPt);
      } else {
        pts[pts.length - 1] = headPt;
      }

      const strokeColor = !inPosition
        ? "#38e8ff"
        : isProfit
          ? "#10e898"
          : "#ff4a72";

      if (pts.length > 1) {
        // Subtle gradient under-curve glow
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 0; i < pts.length - 1; i += 1) {
          const p0 = pts[Math.max(0, i - 1)];
          const p1 = pts[i];
          const p2 = pts[i + 1];
          const p3 = pts[Math.min(pts.length - 1, i + 2)];
          ctx.bezierCurveTo(
            p1.x + (p2.x - p0.x) * CURVE_TENSION,
            p1.y + (p2.y - p0.y) * CURVE_TENSION,
            p2.x - (p3.x - p1.x) * CURVE_TENSION,
            p2.y - (p3.y - p1.y) * CURVE_TENSION,
            p2.x,
            p2.y,
          );
        }
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2.6;
        ctx.shadowColor = strokeColor;
        ctx.shadowBlur = 12;
        ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.lineTo(pts[pts.length - 1].x, plotBottom);
        ctx.lineTo(pts[0].x, plotBottom);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
        grad.addColorStop(
          0,
          !inPosition
            ? "rgba(56, 232, 255, 0.16)"
            : isProfit
              ? "rgba(16, 232, 152, 0.16)"
              : "rgba(255, 74, 114, 0.16)",
        );
        grad.addColorStop(1, "rgba(6, 9, 15, 0)");
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
      }

      // Draw trade execution markers on chart
      for (const m of tradeMarkers) {
        if (m.timestamp < leftT || m.timestamp > visualNow + 400) continue;
        const mx = Math.min(plotRight, Math.max(LEFT_PAD, timeToX(m.timestamp)));
        const my = valToY(m.price);
        const color =
          m.action === "openLong"
            ? "#10e898"
            : m.action === "openShort"
              ? "#ff4a72"
              : m.action === "flip"
                ? "#f5b83d"
                : "#9db7ff";
        const tag =
          m.action === "openLong"
            ? "L"
            : m.action === "openShort"
              ? "S"
              : m.action === "flip"
                ? "F"
                : "C";
        ctx.save();
        ctx.fillStyle = "#08101c";
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(mx, my, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = "800 10px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(tag, mx, my + 0.5);
        ctx.restore();
      }

      // Pulsing current price beacon + right price pill
      const pulse = (Math.sin(perfNow / 240) + 1) / 2;
      ctx.save();
      ctx.shadowColor = strokeColor;
      ctx.shadowBlur = 14 + pulse * 6;
      ctx.fillStyle = strokeColor;
      ctx.beginPath();
      ctx.arc(headPt.x, headPt.y, 5 + pulse * 0.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = strokeColor;
      ctx.fillRect(plotRight + 6, headPt.y - 11, RIGHT_PAD - 10, 22);
      ctx.fillStyle = "#041016";
      ctx.font = "800 11px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        `$${latestVal.toFixed(2)}`,
        plotRight + 6 + (RIGHT_PAD - 10) / 2,
        headPt.y,
      );
      ctx.restore();

      rafId = requestAnimationFrame(frame);
    };

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div ref={containerRef} className="arena-chart-container">
      <canvas ref={canvasRef} />
    </div>
  );
}
