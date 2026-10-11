// Injected by the core into the served UI's index.html. It lives here rather than in web/ so that no edit to the UI
// (or a UI that crashes on load) can take away the core's ability to swap in the next build.
// The page knows which build it was served from: on every (re)connect the core says which build is current, so a
// page whose socket was down when `apply` switched builds reloads as soon as it's back, instead of staying stale.
const liveClient = (build: string) => `(() => {
  const built = ${JSON.stringify(build)};
  const connect = () => {
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/_bismuth/live");
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "reload" || (m.type === "build" && m.build !== built)) location.reload();
    };
    ws.onclose = () => setTimeout(connect, 1000);
  };
  connect();
})();`;

export function injectLiveClient(html: string, build: string): string {
  const tag = `<script>${liveClient(build)}</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : tag + html;
}
