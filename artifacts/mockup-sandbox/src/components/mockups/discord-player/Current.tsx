export function Current() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: "#1e1f22" }}>
      <div style={{ width: 460, fontFamily: "'gg sans', 'Noto Sans', sans-serif" }}>
        {/* Label */}
        <div style={{ color: "#949ba4", fontSize: 12, marginBottom: 4, fontWeight: 500 }}>
          الشكل الحالي (aaa)
        </div>

        {/* Discord Container */}
        <div style={{
          background: "#2b2d31",
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid #1e1f22",
        }}>
          {/* Section: Title + Thumbnail */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "16px 16px 8px 16px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: "#00a8fc", fontSize: 16, fontWeight: 600, lineHeight: 1.3, marginBottom: 4 }}>
                ### Ayed - Lammah \(Official Lyric Video\)
              </div>
              <div style={{ color: "#b5bac1", fontSize: 14, fontWeight: 500 }}>
                Luxury KSA and Sony Music Middle East
              </div>
            </div>
            {/* Thumbnail */}
            <div style={{
              width: 72, height: 72, borderRadius: 4, marginLeft: 12, flexShrink: 0,
              background: "linear-gradient(135deg, #1a3a5c, #2d6a4f)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 28
            }}>🎵</div>
          </div>

          {/* Progress Bar Image (full width - canvas generated) */}
          <div style={{ padding: "0 16px 8px" }}>
            <div style={{
              height: 48, background: "#1e1f22", borderRadius: 6,
              display: "flex", alignItems: "center", padding: "0 12px", gap: 8,
              border: "1px solid #3a3c40"
            }}>
              <div style={{ color: "#949ba4", fontSize: 12, whiteSpace: "nowrap" }}>1:02</div>
              <div style={{ flex: 1, height: 8, background: "#3a3c40", borderRadius: 4, position: "relative" }}>
                <div style={{ width: "30%", height: "100%", background: "#ed4245", borderRadius: 4 }} />
                <div style={{
                  position: "absolute", top: "50%", left: "30%", transform: "translate(-50%, -50%)",
                  width: 14, height: 14, background: "#ed4245", borderRadius: "50%",
                  boxShadow: "0 0 0 3px #2b2d31"
                }} />
              </div>
              <div style={{ color: "#949ba4", fontSize: 12, whiteSpace: "nowrap" }}>4:28</div>
            </div>
          </div>

          {/* Loop / Requester / Volume text block */}
          <div style={{ padding: "0 16px 12px" }}>
            <div style={{
              fontFamily: "monospace", fontSize: 13, color: "#b5bac1", lineHeight: 1.8,
              background: "#1e1f22", borderRadius: 4, padding: "8px 12px",
              border: "1px solid #3a3c40"
            }}>
              <div><span style={{ color: "#949ba4" }}>Loop      : </span><span style={{ color: "#fff" }}>OFF</span></div>
              <div><span style={{ color: "#949ba4" }}>Requester : </span><span style={{ color: "#fff" }}>Ahmed.</span></div>
              <div><span style={{ color: "#949ba4" }}>Volume    : </span><span style={{ color: "#fff" }}>100%</span></div>
            </div>
          </div>

          {/* Separator */}
          <div style={{ height: 1, background: "#1e1f22", margin: "0 16px" }} />

          {/* Artist Select Menu */}
          <div style={{ padding: "10px 16px 6px" }}>
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
          <div style={{ padding: "0 16px 10px" }}>
            <div style={{
              background: "#1e1f22", borderRadius: 4, padding: "10px 14px",
              color: "#949ba4", fontSize: 14, display: "flex", justifyContent: "space-between",
              alignItems: "center", cursor: "pointer", border: "1px solid #3a3c40"
            }}>
              <span>الفلاتر الصوتية • الحالي: بدون فلتر ‣</span>
              <span style={{ fontSize: 10 }}>▼</span>
            </div>
          </div>

          {/* Button Row 1: 5 buttons */}
          <div style={{ padding: "0 16px 8px", display: "flex", gap: 6 }}>
            {["🔉", "🔄", "⏸", "⏭", "🔊"].map((emoji, i) => (
              <div key={i} style={{
                flex: 1, height: 40, background: "#4e5058", borderRadius: 4,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, cursor: "pointer"
              }}>{emoji}</div>
            ))}
          </div>

          {/* Button Row 2: Red stop button */}
          <div style={{ padding: "0 16px 16px", display: "flex", gap: 6 }}>
            <div style={{
              width: 64, height: 40, background: "#ed4245", borderRadius: 4,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 18, cursor: "pointer"
            }}>⏹</div>
          </div>
        </div>

        {/* Problem labels */}
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            { color: "#ed4245", text: "❌ البار صورة كاملة — يكبّر الكونتينر بشكل مبالغ" },
            { color: "#ed4245", text: "❌ الأزرار 5+1 — غير متطابق مع الهدف" },
            { color: "#ed4245", text: "❌ Loop/Volume في المنتصف كتلة نصية" },
            { color: "#ed4245", text: "❌ البار ثابت — لا يتحدث تلقائياً" },
          ].map((item, i) => (
            <div key={i} style={{ color: item.color, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <span>{item.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
