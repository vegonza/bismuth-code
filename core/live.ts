// Injected by the core into the served UI's index.html. It lives here rather than in web/ so that no edit to the UI
// (or a UI that crashes on load) can take away the core's ability to swap in the next build.
// The page knows which build it was served from: on every (re)connect the core says which build is current, so a
// page whose socket was down when `apply` switched builds reloads as soon as it's back, instead of staying stale.
// A phone suspends a page in the background without its socket closing (it stays open on the page's side, long after
// the core has dropped it), so a page coming back into view connects afresh and asks again.
const liveClient = (build: string) => `(() => {
  const built = ${JSON.stringify(build)};
  let ws;
  const connect = () => {
    const s = (ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/_bismuth/live"));
    s.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "reload" || (m.type === "build" && m.build !== built)) location.reload();
    };
    s.onclose = () => s === ws && setTimeout(connect, 1000);
  };
  const recheck = () => {
    if (document.visibilityState !== "visible") return;
    const old = ws;
    connect();
    old.close();
  };
  document.addEventListener("visibilitychange", recheck);
  addEventListener("pageshow", (e) => e.persisted && recheck());
  addEventListener("online", recheck);
  connect();
})();`;

export function injectLiveClient(html: string, build: string): string {
  const tag = `<script>${liveClient(build)}</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : tag + html;
}
