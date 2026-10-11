// Libraries only some views need, bundled apart (web/lazy/, see core/ui.ts) and fetched the first time one's used.
// The import's path is a value, so the window's own bundle leaves it be; it resolves beside that bundle.
const imported = (name: string) => import(/* @vite-ignore */ `./lazy/${name}.js`);

export const loadMermaid = (): Promise<typeof import("./lazy/mermaid")> => imported("mermaid");
export const loadXlsx = (): Promise<typeof import("./lazy/xlsx")> => imported("xlsx");
