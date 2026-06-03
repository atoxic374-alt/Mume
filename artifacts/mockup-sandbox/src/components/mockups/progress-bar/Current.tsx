export function Current() {
  const ratio = 0.62;
  const color = "#7c6fcd";
  const railW = 520;
  const railH = 5;
  const knobR = 5;
  const fillW = railW * ratio;
  const knobX = fillW;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-10"
      style={{ background: "#1e1f22", fontFamily: "'Segoe UI', sans-serif" }}>
      <p style={{ color: "#aaa", fontSize: 13, letterSpacing: 1, textTransform: "uppercase", marginBottom: -4 }}>
        الحالي — بدون Glow
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
            {/* filled portion — NO glow */}
            <div style={{
              position: "absolute",
              left: 0,
              width: fillW,
              height: railH,
              borderRadius: railH / 2,
              background: color,
            }} />
            {/* knob */}
            <div style={{
              position: "absolute",
              left: knobX - knobR,
              top: "50%",
              transform: "translateY(-50%)",
              width: knobR * 2,
              height: knobR * 2,
              borderRadius: "50%",
              background: "#fff",
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
