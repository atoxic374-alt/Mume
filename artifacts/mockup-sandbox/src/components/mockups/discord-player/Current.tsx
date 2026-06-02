export function Current() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: "#1e1f22" }}>
      <div style={{ width: 460, fontFamily: "'gg sans', 'Noto Sans', sans-serif" }}>
        <div style={{ color: "#faa61a", fontSize: 12, marginBottom: 6, fontWeight: 600, letterSpacing: 0.5 }}>
          🎯 الهدف (الصورة)
        </div>

        <div style={{ background: "#2b2d31", borderRadius: 8, overflow: "hidden", border: "1px solid #1e1f22" }}>

          {/* Title + Large Thumbnail */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "16px 16px 12px 16px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: "#00a8fc", fontSize: 17, fontWeight: 700, lineHeight: 1.35 }}>
                Tame Impala – The Less I Know The Better (Audio)
              </div>
            </div>
            <div style={{
              width: 90, height: 90, borderRadius: 6, marginLeft: 14, flexShrink: 0,
              background: "linear-gradient(135deg, #2d0e5c, #8c1a1a)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 36, overflow: "hidden"
            }}>🎵</div>
          </div>

          {/* Progress: 0:10 [bar] */}
          <div style={{ padding: "0 16px 4px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: "#b5bac1", fontSize: 14, fontFamily: "monospace", whiteSpace: "nowrap" }}>0:10</span>
              <div style={{ flex: 1, height: 6, background: "#3a3c40", borderRadius: 3, position: "relative" }}>
                <div style={{ width: "5%", height: "100%", background: "#b5bac1", borderRadius: 3 }} />
                <div style={{
                  position: "absolute", top: "50%", left: "5%",
                  transform: "translate(-50%, -50%)",
                  width: 13, height: 13, background: "#e3e5e8", borderRadius: "50%",
                  boxShadow: "0 0 0 2px #2b2d31"
                }} />
              </div>
            </div>
          </div>

          {/* Total time BELOW bar (as in screenshot) */}
          <div style={{ padding: "2px 16px 12px" }}>
            <span style={{ color: "#b5bac1", fontSize: 14, fontFamily: "monospace" }}>3:38</span>
          </div>

          {/* Row 1: 4 buttons */}
          <div style={{ padding: "0 16px 6px", display: "flex", gap: 8 }}>
            {[
              { emoji: "⏮", label: "prev" },
              { emoji: "⏹", label: "stop" },
              { emoji: "⏸", label: "pause" },
              { emoji: "⏭", label: "skip" },
            ].map((btn, i) => (
              <div key={i} style={{
                flex: 1, height: 44,
                background: "#3a3c40", borderRadius: 6,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 20, cursor: "pointer"
              }}>{btn.emoji}</div>
            ))}
          </div>

          {/* Row 2: 4 buttons */}
          <div style={{ padding: "0 16px 16px", display: "flex", gap: 8 }}>
            {["🔉", "🔄", "📋", "🔊"].map((emoji, i) => (
              <div key={i} style={{
                flex: 1, height: 44, background: "#3a3c40", borderRadius: 6,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 20, cursor: "pointer"
              }}>{emoji}</div>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          {[
            "الوقت الكامل (3:38) تحت البار — سطر منفصل",
            "Row 2 فيها 4 أزرار فقط (بدون ❤️)",
            "بدون select menus",
            "بدون سطر Loop/Vol",
          ].map((t, i) => (
            <div key={i} style={{ color: "#faa61a", fontSize: 11 }}>• {t}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
