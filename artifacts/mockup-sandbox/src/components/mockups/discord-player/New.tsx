import { useState, useEffect } from "react";

export function New() {
  const [position, setPosition] = useState(10);
  const total = 218;

  useEffect(() => {
    const interval = setInterval(() => {
      setPosition(p => Math.min(p + 15, total));
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  function fmt(secs: number) {
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  function buildBar(pos: number, dur: number, len = 22) {
    const ratio = dur > 0 ? Math.min(1, pos / dur) : 0;
    const filled = Math.floor(ratio * len);
    return { filled: "─".repeat(filled), empty: "─".repeat(Math.max(0, len - filled)) };
  }

  const { filled, empty } = buildBar(position, total);
  // Extracted color from target screenshot: #bfbfc7
  const BAR_COLOR = "#bfbfc7";
  const EMPTY_COLOR = "#3a3c40";
  const KNOB_COLOR = "#e3e5e8";

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: "#1e1f22" }}>
      <div style={{ width: 460, fontFamily: "'gg sans', 'Noto Sans', sans-serif" }}>
        <div style={{ color: "#57f287", fontSize: 12, marginBottom: 6, fontWeight: 600, letterSpacing: 0.5 }}>
          ✅ بوتنا بعد التحديث
        </div>

        <div style={{ background: "#2b2d31", borderRadius: 8, overflow: "hidden", border: "1px solid #1e1f22" }}>

          {/* Title + Thumbnail */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "16px 16px 10px 16px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: "#00a8fc", fontSize: 17, fontWeight: 700, lineHeight: 1.35 }}>
                Tame Impala – The Less I Know The Better (Audio)
              </div>
            </div>
            <div style={{
              width: 90, height: 90, borderRadius: 6, marginLeft: 14, flexShrink: 0,
              background: "linear-gradient(135deg, #2d0e5c, #8c1a1a)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 36,
            }}>🎵</div>
          </div>

          {/* ANSI-style progress bar — exact color #bfbfc7 extracted from screenshot */}
          <div style={{
            margin: "0 16px 6px",
            background: "#1e1f22", borderRadius: 4,
            padding: "8px 12px",
            fontFamily: "monospace", fontSize: 13, letterSpacing: 0,
            display: "flex", alignItems: "center", gap: 0,
          }}>
            <span style={{ color: BAR_COLOR, whiteSpace: "pre" }}>{fmt(position)}  {filled}</span>
            <span style={{ color: KNOB_COLOR, fontWeight: 700 }}>●</span>
            <span style={{ color: EMPTY_COLOR, whiteSpace: "pre" }}>{empty}</span>
            <span style={{ color: BAR_COLOR, whiteSpace: "pre" }}>  {fmt(total)}</span>
          </div>

          {/* Info line */}
          <div style={{ padding: "2px 16px 10px" }}>
            <div style={{ fontFamily: "monospace", fontSize: 11, color: "#949ba4", display: "flex", gap: 10 }}>
              <span>`🔁 OFF`</span>
              <span>`🔊 100%`</span>
              <span>`👤 Ahmed.`</span>
            </div>
          </div>

          {/* Separator */}
          <div style={{ height: 1, background: "#3a3c40", margin: "0 16px 8px" }} />

          {/* Artist Select Menu */}
          <div style={{ padding: "0 16px 6px" }}>
            <div style={{
              background: "#1e1f22", borderRadius: 4, padding: "9px 14px",
              color: "#949ba4", fontSize: 13, display: "flex", justifyContent: "space-between",
              alignItems: "center", border: "1px solid #3a3c40"
            }}>
              <span>أفضل 5 أغاني لنفس الفنان</span><span style={{ fontSize: 10 }}>▼</span>
            </div>
          </div>

          {/* Filter Select Menu */}
          <div style={{ padding: "0 16px 8px" }}>
            <div style={{
              background: "#1e1f22", borderRadius: 4, padding: "9px 14px",
              color: "#949ba4", fontSize: 13, display: "flex", justifyContent: "space-between",
              alignItems: "center", border: "1px solid #3a3c40"
            }}>
              <span>الفلاتر الصوتية • الحالي: بدون فلتر</span><span style={{ fontSize: 10 }}>▼</span>
            </div>
          </div>

          {/* Row 1: ⏮ ⏹ ⏸ ⏭ */}
          <div style={{ padding: "0 16px 6px", display: "flex", gap: 6 }}>
            {[
              { emoji: "⏮", red: false },
              { emoji: "⏹", red: true },
              { emoji: "⏸", red: false },
              { emoji: "⏭", red: false },
            ].map((btn, i) => (
              <div key={i} style={{
                flex: 1, height: 40,
                background: btn.red ? "#ed4245" : "#4e5058", borderRadius: 4,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18,
              }}>{btn.emoji}</div>
            ))}
          </div>

          {/* Row 2: 🔉 🔄 📋 🔊 ❤️ */}
          <div style={{ padding: "0 16px 14px", display: "flex", gap: 6 }}>
            {["🔉", "🔄", "📋", "🔊", "❤️"].map((emoji, i) => (
              <div key={i} style={{
                flex: 1, height: 40, background: "#4e5058", borderRadius: 4,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18,
              }}>{emoji}</div>
            ))}
          </div>
        </div>

        {/* Color note */}
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ color: "#57f287", fontSize: 11 }}>
            ✅ لون البار: <span style={{ color: BAR_COLOR, fontFamily: "monospace" }}>#bfbfc7</span> — مستخرج بدقة من الصورة
          </div>
          <div style={{ color: "#57f287", fontSize: 11 }}>✅ البار يتحدث كل 15 ثانية تلقائياً</div>
          <div style={{ color: "#949ba4", fontSize: 11 }}>◦ عندنا select menus + ❤️ زيادة (طلبتها)</div>
        </div>
      </div>
    </div>
  );
}
