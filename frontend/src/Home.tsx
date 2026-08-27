import { useCallback, useEffect, useRef, useState } from "react";
import { api, uploadMedia } from "./api";
import Brand from "./Brand";
import { notify } from "./dialogs";
import {
  LANG_OPTIONS,
  RUNNING_STATUSES,
  langLabel,
  statusLabel,
  type Lang,
  type Project,
} from "./types";
import { formatTime } from "./segments";

interface Upload {
  id: number;
  file: File;
  name: string;
  /** 送出當下選的語言;之後改了下拉選單也不影響重試 */
  lang: Lang;
  progress: number;
  error?: string;
}

/** 刪除專案後可以反悔的秒數 */
const UNDO_MS = 5000;

export default function Home() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [ffmpegOk, setFfmpegOk] = useState(true);
  const [lang, setLang] = useState<Lang>(
    () => (localStorage.getItem("vidscribe:lang") as Lang) || "zh"
  );
  const langRef = useRef(lang);
  langRef.current = lang;
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSeq = useRef(0);
  // 按了刪除但還在反悔期內的專案:先從列表拿掉,時間到才真的刪
  const [trashed, setTrashed] = useState<Project[]>([]);
  const trashTimers = useRef(new Map<string, number>());

  useEffect(() => {
    api
      .getHealth()
      .then((h) => setFfmpegOk(h.ffmpeg))
      .catch(() => {});
  }, []);

  const refresh = useCallback(() => {
    api.listProjects().then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // 切回這個分頁時補問一次,才不用等下一輪
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  // 有東西在跑才需要一直問;閒著時放慢,分頁在背景就完全不問
  const busy =
    uploads.length > 0 || (projects?.some((p) => RUNNING_STATUSES.includes(p.status)) ?? false);
  useEffect(() => {
    const timer = setInterval(
      () => {
        if (!document.hidden) refresh();
      },
      busy ? 2000 : 10000
    );
    return () => clearInterval(timer);
  }, [refresh, busy]);

  /** 送出(或重送)一筆上傳;entry 已經在清單裡,這裡只更新它的進度/錯誤。 */
  const runUpload = useCallback(
    (entry: Upload) => {
      setUploads((u) =>
        u.map((x) => (x.id === entry.id ? { ...x, progress: 0, error: undefined } : x))
      );
      uploadMedia(entry.file, entry.lang, (ratio) => {
        setUploads((u) => u.map((x) => (x.id === entry.id ? { ...x, progress: ratio } : x)));
      })
        .then(() => {
          setUploads((u) => u.filter((x) => x.id !== entry.id));
          refresh();
        })
        .catch((err: Error) => {
          setUploads((u) => u.map((x) => (x.id === entry.id ? { ...x, error: err.message } : x)));
        });
    },
    [refresh]
  );

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const added: Upload[] = Array.from(files).map((file) => ({
        id: ++uploadSeq.current,
        file,
        name: file.name,
        lang: langRef.current,
        progress: 0,
      }));
      setUploads((u) => [...u, ...added]);
      added.forEach(runUpload);
    },
    [runUpload]
  );

  /** 刪除:先從列表拿掉並開始倒數,時間到才真的送出,中間可以反悔。 */
  const deleteProject = useCallback(
    (p: Project) => {
      if (trashTimers.current.has(p.id)) return;
      setTrashed((t) => [...t, p]);
      trashTimers.current.set(
        p.id,
        window.setTimeout(() => {
          trashTimers.current.delete(p.id);
          setTrashed((t) => t.filter((x) => x.id !== p.id));
          api
            .deleteProject(p.id)
            .then(refresh)
            .catch((e: Error) => notify(e.message));
        }, UNDO_MS)
      );
    },
    [refresh]
  );

  const undoDelete = useCallback((id: string) => {
    const timer = trashTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    trashTimers.current.delete(id);
    setTrashed((t) => t.filter((x) => x.id !== id));
  }, []);

  // 離開首頁(例如點進某個專案)就把還在倒數的刪除送出去,不要無聲無息地取消
  useEffect(() => {
    const timers = trashTimers.current;
    return () => {
      timers.forEach((timer, id) => {
        window.clearTimeout(timer);
        api.deleteProject(id).catch(() => {});
      });
      timers.clear();
    };
  }, []);

  // 倒數中的專案先當作已經刪掉,不然每 2 秒的輪詢會把它抓回列表
  const visible = (projects ?? []).filter((p) => !trashed.some((t) => t.id === p.id));

  return (
    <div className="page">
      <header className="topbar">
        <Brand />
        <span className="topbar-note">本機字幕工具,檔案不離開你的電腦</span>
      </header>

      <main className="home">
        {!ffmpegOk && (
          <div className="health-banner">
            找不到 ffmpeg,辨識和匯出都無法運作——請執行專案資料夾裡的
            setup.bat 自動安裝,裝完重開伺服器。
          </div>
        )}
        <div
          className={"dropzone" + (dragging ? " dragging" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") fileInput.current?.click();
          }}
        >
          <div className="dropzone-title">把影片或音檔丟進來</div>
          <div className="dropzone-sub">或點一下選擇檔案,放開就開始辨識</div>
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept="video/*,audio/*,.mkv,.mts,.m2ts"
            onChange={(e) => {
              if (e.target.files?.length) handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        <div className="upload-lang">
          <label htmlFor="lang-select">辨識語言</label>
          <select
            id="lang-select"
            className="select"
            value={lang}
            onChange={(e) => {
              const v = e.target.value as Lang;
              setLang(v);
              localStorage.setItem("vidscribe:lang", v);
            }}
          >
            {LANG_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="hint">選錯也沒關係,進專案後可以換語言重新辨識</span>
        </div>

        {uploads.length > 0 && (
          <section className="upload-list">
            {uploads.map((u) => (
              <div key={u.id} className={"upload-item" + (u.error ? " failed" : "")}>
                <span className="upload-name">{u.name}</span>
                {u.error ? (
                  <span className="upload-error">
                    {u.error}
                    <button className="link-btn" onClick={() => runUpload(u)}>
                      重試
                    </button>
                    <button
                      className="link-btn"
                      onClick={() => setUploads((list) => list.filter((x) => x.id !== u.id))}
                    >
                      不用了
                    </button>
                  </span>
                ) : (
                  <span className="upload-progress">
                    <span className="bar">
                      <span className="bar-fill" style={{ width: `${u.progress * 100}%` }} />
                    </span>
                    上傳中 {Math.round(u.progress * 100)}%
                  </span>
                )}
              </div>
            ))}
          </section>
        )}

        {projects === null ? (
          <p className="empty-hint">載入中…</p>
        ) : visible.length === 0 && uploads.length === 0 ? (
          <p className="empty-hint">還沒有專案。丟一支影片進來,一兩分鐘後就有逐字稿。</p>
        ) : (
          <section className="project-grid">
            {visible.map((p) => {
              const running = RUNNING_STATUSES.includes(p.status);
              return (
                <a key={p.id} className="project-card" href={`#/p/${p.id}`}>
                  <div className="project-name">{p.name}</div>
                  <div className="project-meta">
                    <span className="mono">
                      {p.duration ? formatTime(p.duration) : "--:--"}
                    </span>
                    <span>{new Date(p.created_at * 1000).toLocaleDateString("zh-TW")}</span>
                    {p.lang && p.lang !== "zh" && (
                      <span className="lang-tag">{langLabel(p.lang)}</span>
                    )}
                  </div>
                  <div className="project-status">
                    {running && <span className="spinner" aria-hidden />}
                    <span className={"status-text status-" + p.status}>{statusLabel(p)}</span>
                  </div>
                  {p.status === "transcribing" && (
                    <span className="bar card-bar">
                      <span className="bar-fill" style={{ width: `${p.progress * 100}%` }} />
                    </span>
                  )}
                  <button
                    className="card-delete"
                    title="刪除專案"
                    onClick={(e) => {
                      e.preventDefault();
                      deleteProject(p);
                    }}
                  >
                    ✕
                  </button>
                </a>
              );
            })}
          </section>
        )}
      </main>

      {trashed.length > 0 && (
        <div className="undo-bar" role="status">
          {trashed.map((p) => (
            <div key={p.id} className="undo-item">
              <span className="undo-text">已刪除「{p.name}」</span>
              <button className="btn small" onClick={() => undoDelete(p.id)}>
                復原
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
