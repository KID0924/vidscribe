import type {
  BurnJob, Clip, ClipExportJob, ClipsJob, DictEntry, FixJob, Project, Segment,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* keep statusText */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  getHealth: () =>
    fetch("/api/health").then((r) =>
      json<{ ffmpeg: boolean; claude: boolean; face: boolean }>(r)
    ),

  listProjects: () => fetch("/api/projects").then((r) => json<Project[]>(r)),

  getProject: (id: string) => fetch(`/api/projects/${id}`).then((r) => json<Project>(r)),

  deleteProject: (id: string) =>
    fetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),

  retranscribe: (id: string) =>
    fetch(`/api/projects/${id}/transcribe`, { method: "POST" }).then((r) => json<Project>(r)),

  getSubtitles: (id: string) =>
    fetch(`/api/projects/${id}/subtitles`).then((r) =>
      json<{ version: number; segments: Segment[]; marks?: number[] }>(r)
    ),

  saveSubtitles: (id: string, segments: Segment[], marks: number[]) =>
    fetch(`/api/projects/${id}/subtitles`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments, marks }),
    }).then((r) => json<{ ok: boolean }>(r)),

  getCuts: (id: string) =>
    fetch(`/api/projects/${id}/cuts`).then((r) =>
      json<{ status: string; cuts: number[]; error: string | null }>(r)
    ),

  startCuts: (id: string) =>
    fetch(`/api/projects/${id}/cuts`, { method: "POST" }).then((r) =>
      json<{ status: string; cuts: number[]; error: string | null }>(r)
    ),

  getDictionary: () =>
    fetch("/api/dictionary").then((r) => json<{ entries: DictEntry[] }>(r)),

  addDictEntry: (wrong: string, right: string) =>
    fetch("/api/dictionary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong, right }),
    }).then((r) => json<{ entries: DictEntry[] }>(r)),

  deleteDictEntry: (id: string) =>
    fetch(`/api/dictionary/${id}`, { method: "DELETE" }).then((r) =>
      json<{ entries: DictEntry[] }>(r)
    ),

  getLlmStatus: () =>
    fetch("/api/llm/status").then((r) => json<{ available: boolean }>(r)),

  /** ids 給定時只校正那些字幕(自選範圍),省略則整份。 */
  startFix: (id: string, ids?: string[]) =>
    fetch(`/api/projects/${id}/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids ? { ids } : {}),
    }).then((r) => json<FixJob>(r)),

  getFix: (id: string) =>
    fetch(`/api/projects/${id}/fix`).then((r) => json<FixJob>(r)),

  /** 把審閱掉的建議從後端移除(分析進行中也可以呼叫)。 */
  removeFix: (id: string, remove: { id: string; old: string }[]) =>
    fetch(`/api/projects/${id}/fix`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remove }),
    }).then((r) => json<{ ok: boolean }>(r)),

  cancelFix: (id: string) =>
    fetch(`/api/projects/${id}/fix`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),

  getWaveform: (id: string) =>
    fetch(`/api/projects/${id}/waveform`).then((r) =>
      json<{ rate: number; peaks: number[] }>(r)
    ),

  startBurn: (id: string) =>
    fetch(`/api/projects/${id}/burn`, { method: "POST" }).then((r) => json<BurnJob>(r)),

  getBurn: (id: string) =>
    fetch(`/api/projects/${id}/burn`).then((r) => json<BurnJob>(r)),

  cancelBurn: (id: string) =>
    fetch(`/api/projects/${id}/burn`, { method: "DELETE" }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  burnFileUrl: (id: string) => `/api/projects/${id}/burn/file`,

  startClipsAnalyze: (id: string) =>
    fetch(`/api/projects/${id}/clips/analyze`, { method: "POST" }).then((r) =>
      json<ClipsJob>(r)
    ),

  getClips: (id: string) =>
    fetch(`/api/projects/${id}/clips`).then((r) => json<ClipsJob>(r)),

  updateClips: (id: string, clips: Clip[]) =>
    fetch(`/api/projects/${id}/clips`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips }),
    }).then((r) => json<{ clips: Clip[] }>(r)),

  cancelClips: (id: string) =>
    fetch(`/api/projects/${id}/clips`, { method: "DELETE" }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  /** 切換短片版型;切拼接時後端會做人臉偵測(第一次較慢,約 2~3 秒)。 */
  setClipLayout: (id: string, cid: string, layout: "single" | "stack") =>
    fetch(`/api/projects/${id}/clips/${cid}/layout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layout }),
    }).then((r) => json<Clip>(r)),

  startClipExport: (id: string, ids: string[]) =>
    fetch(`/api/projects/${id}/clips/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => json<ClipExportJob>(r)),

  getClipExport: (id: string) =>
    fetch(`/api/projects/${id}/clips/export`).then((r) => json<ClipExportJob>(r)),

  cancelClipExport: (id: string) =>
    fetch(`/api/projects/${id}/clips/export`, { method: "DELETE" }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  clipFileUrl: (id: string, cid: string) => `/api/projects/${id}/clips/${cid}/file`,

  mediaUrl: (id: string) => `/api/projects/${id}/media`,
  exportUrl: (id: string, format: string) => `/api/projects/${id}/export?format=${format}`,
};

/** 用 XHR 上傳才拿得到進度。 */
export function uploadMedia(
  file: File,
  onProgress: (ratio: number) => void
): Promise<Project> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/projects");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        let msg = `上傳失敗(${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText).detail ?? msg;
        } catch {
          /* keep default */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("連不上伺服器"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
