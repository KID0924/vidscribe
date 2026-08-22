const HOTKEYS: [string, string][] = [
  ["Enter", "在游標處斷句"],
  ["Backspace", "句首按下與上句合併"],
  ["Tab / Shift+Tab", "跳到下一句 / 上一句"],
  ["空白鍵", "播放 / 暫停"],
  ["↑ ↓", "選句並跳到該時間"],
  ["B", "在播放位置切開字幕"],
  ["Delete", "刪除選中的字幕"],
  ["雙擊波形", "新增 / 移除 Mark 點"],
  ["Ctrl+Z / Ctrl+Y", "復原 / 重做"],
];

/** 工具列的快捷鍵說明選單(實際按鍵處理在 Editor 的全域 keydown)。 */
export default function HotkeyMenu() {
  return (
    <details className="hotkey-menu">
      <summary className="btn small">快捷鍵</summary>
      <div className="hotkey-panel">
        {HOTKEYS.map(([key, desc]) => (
          <div key={key} className="hotkey-row">
            <kbd>{key}</kbd>
            <span>{desc}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
