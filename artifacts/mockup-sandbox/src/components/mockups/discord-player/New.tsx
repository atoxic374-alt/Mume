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

  const pct = Math.round((position / total) * 100);
  const barFilled = Math.round((position / total) * 22);
  const barEmpty = 22 - barFilled;

  function fmt(secs: number) {
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: "#1e1f22" }}>
      <div style={{ width: 460, fontFamily: "'gg sans', 'Noto Sans', sans-serif" }}>
        {/* Label */}
        <div style={{ color: "#57f287", fontSize: 12, marginBottom: 4, fontWeight: 500 }}>
          الشكل الجديد
        </div>

        {/* Discord Container */}
        <div style={{
          background: "#2b2d31",
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid #1e1f22",
        }}>

          {/* Section: Title + Thumbnail (compact) */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 10px 16px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: "#00a8fc", fontSize: 15, fontWeight: 600, lineHeight: 1.3, marginBottom: 2 }}>
                Tame Impala - The Less I Know The Better (Audio)
              </div>
              <div style={{ color: "#b5bac1", fontSize: 13 }}>Tame Impala</div>
            </div>
            {/* Thumbnail — same size, compact */}
            <div style={{
              width: 60, height: 60, borderRadius: 4, marginLeft: 12, flexShrink: 0,
              background: "linear-gradient(135deg, #5b2c8c, #c0392b)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 24, overflow: "hidden"
            }}>🎵</div>
          </div>

          {/* Compact inline progress bar (TEXT — no image, no MediaGallery) */}
          <div style={{ padding: "0 16px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#b5bac1", fontSize: 13, fontFamily: "monospace", whiteSpace: "nowrap" }}>
                {fmt(position)}
              </span>
              <div style={{ flex: 1, height: 6, background: "#3a3c40", borderRadius: 3, position: "relative" }}>
                <div style={{
                  width: `${pct}%`, height: "100%",
                  background: "#ed4245", borderRadius: 3,
                  transition: "width 0.8s ease"
                }} />
                <div style={{
                  position: "absolute", top: "50%", left: `${pct}%`,
                  transform: "translate(-50%, -50%)",
                  width: 12, height: 12, background: "#ed4245", borderRadius: "50%",
                  boxShadow: "0 0 0 2px #2b2d31"
                }} />
              </div>
              <span style={{ color: "#b5bac1", fontSize: 13, fontFamily: "monospace", whiteSpace: "nowrap" }}>
                {fmt(total)}
              </span>
            </div>
          </div>

          {/* Separator */}
          <div style={{ height: 1, background: "#3a3c40", margin: "0 16px 8px" }} />

          {/* Artist Select Menu */}
          <div style={{ padding: "0 16px 6px" }}>
            <div style={{
              background: "#1e1f22", borderRadius: 4, padding: "10px 14px",
              color: "#949ba4", fontSize: 14, display: "flex", justifyContent: "space-between",
              alignItems: "center", cursor: "pointer", border: "1px solid #3a3c40"
            }}>
              <span>أفضل 5 أغاني لنفس الفنان ‣</span>
              <span style={{ fontSize: 10 }}>▼</span>
            </div>
          </div>

          {/* Filter Select Menu */}
          <div style={{ padding: "0 16px 8px" }}>
            <div style={{
              background: "#1e1f22", borderRadius: 4, padding: "10px 14px",
              color: "#949ba4", fontSize: 14, display: "flex", justifyContent: "space-between",
              alignItems: "center", cursor: "pointer", border: "1px solid #3a3c40"
            }}>
              <span>الفلاتر الصوتية • الحالي: بدون فلتر ‣</span>
              <span style={{ fontSize: 10 }}>▼</span>
            </div>
          </div>

          {/* Button Row 1: 4 buttons (⏮ ⏹ ⏸ ⏭) */}
          <div style={{ padding: "0 16px 6px", display: "flex", gap: 6 }}>
            {[
              { emoji: "⏮", label: "prev" },
              { emoji: "⏹", label: "stop", red: true },
              { emoji: "⏸", label: "pause" },
              { emoji: "⏭", label: "skip" },
            ].map((btn, i) => (
              <div key={i} style={{
                flex: 1, height: 40,
                background: btn.red ? "#ed4245" : "#4e5058",
                borderRadius: 4,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, cursor: "pointer"
              }}>{btn.emoji}</div>
            ))}
          </div>

          {/* Button Row 2: 4 buttons (🔉 🔄 📋 🔊) */}
          <div style={{ padding: "0 16px 10px", display: "flex", gap: 6 }}>
            {["🔉", "🔄", "📋", "🔊"].map((emoji, i) => (
              <div key={i} style={{
                flex: 1, height: 40, background: "#4e5058", borderRadius: 4,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, cursor: "pointer"
              }}>{emoji}</div>
            ))}
          </div>

          {/* Bottom section: Loop/Volume/Requester → bottom-right */}
          <div style={{
            padding: "0 16px 14px",
            display: "flex", justifyContent: "flex-end"
          }}>
            <div style={{
              fontFamily: "monospace", fontSize: 11, color: "#949ba4", lineHeight: 1.7,
              textAlign: "right"
            }}>
              <div>Loop : <span style={{ color: "#b5bac1" }}>OFF</span></div>
              <div>Requester : <span style={{ color: "#b5bac1" }}>Ahmed.</span></div>
              <div>Volume : <span style={{ color: "#b5bac1" }}>100%</span></div>
            </div>
          </div>
        </div>

        {/* Fix labels */}
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            { color: "#57f287", text: "✅ البار نصي compact — الكونتينر صغير ومتناسب" },
            { color: "#57f287", text: "✅ الأزرار 4+4 — تطابق الهدف" },
            { color: "#57f287", text: "✅ Loop/Volume أسفل يمين" },
            { color: "#57f287", text: "✅ البار يتحدث كل 15 ثانية تلقائياً" },
            { color: "#57f287", text: "✅ نهاية الأغنية → البار يكتمل 100%" },
          ].map((item, i) => (
            <div key={i} style={{ color: item.color, fontSize: 12 }}>
              {item.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
