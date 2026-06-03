export function WithGlow() {
  const ratio = 0.62;
  const color = "#7c6fcd";
  const glowColor = "rgba(124,111,205,0.55)";
  const railW = 520;
  const railH = 5;
  const knobR = 5;
  const fillW = railW * ratio;
  const knobX = fillW;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-10"
      style={{ background: "#1e1f22", fontFamily: "'Segoe UI', sans-serif" }}>
      <p style={{ color: "#aaa", fontSize: 13, letterSpacing: 1, textTransform: "uppercase", marginBottom: -4 }}>
        مع Gradient Glow Effect
      </p>
      <div style={{
        background: "#2b2d31",
        borderRadius: 12,
        padding: "28px 36px",
        width: 640,
        boxShadow: "0 4px 20px rgba(0,0,0,0.5)"
      }}>
        {/* track info */}
        <div style={{ color: "#fff", fontSize: 14, fontWeight: 600, marginBottom: 18 }}>
          🎵 اسم الأغنية الحالية — اسم الفنان
        </div>

        {/* progress bar row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* current time */}
          <span style={{ color: "#e1e3e8", fontSize: 14, fontWeight: 700, minWidth: 34, textAlign: "right" }}>
            3:40
          </span>

          {/* rail container */}
          <div style={{ position: "relative", width: railW, height: Math.max(knobR * 2 + 4, railH + 4), display: "flex", alignItems: "center" }}>
            {/* background rail */}
            <div style={{
              position: "absolute",
              left: 0,
              width: railW,
              height: railH,
              borderRadius: railH / 2,
              background: "rgba(70,73,80,0.88)",
            }} />
            {/* filled portion — WITH gradient glow */}
            <div style={{
              position: "absolute",
              left: 0,
              width: fillW,
              height: railH,
              borderRadius: railH / 2,
              background: `linear-gradient(90deg, ${color} 0%, #a99ee8 72%, #c8c0f5 100%)`,
              boxShadow: `0 0 8px 2px ${glowColor}, 0 0 16px 4px rgba(124,111,205,0.25)`,
            }} />
            {/* knob — with subtle glow too */}
            <div style={{
              position: "absolute",
              left: knobX - knobR,
              top: "50%",
              transform: "translateY(-50%)",
              width: knobR * 2,
              height: knobR * 2,
              borderRadius: "50%",
              background: "#fff",
              boxShadow: `0 0 6px 2px ${glowColor}`,
            }} />
          </div>

          {/* total time */}
          <span style={{ color: "#e1e3e8", fontSize: 14, fontWeight: 700, minWidth: 34 }}>
            5:58
          </span>
        </div>
      </div>
    </div>
  );
}
