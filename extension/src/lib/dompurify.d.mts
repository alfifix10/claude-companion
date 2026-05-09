// Type stub for the vendored DOMPurify ESM bundle.
// We only use a tiny surface (sanitize + addHook), so the stub is
// intentionally minimal — full types come from the upstream package
// when developers `npm install dompurify`. At runtime the extension
// loads the vendored ./dompurify.mjs directly (no node_modules access
// from the browser sandbox).
type Config = {
  ALLOWED_TAGS?: readonly string[];
  ALLOWED_ATTR?: readonly string[];
  USE_PROFILES?: { html?: boolean; svg?: boolean; mathMl?: boolean };
};

type AfterSanitizeAttributesHook = (
  node: Element,
  data: unknown,
  config: Config,
) => void;

declare const DOMPurify: {
  sanitize(input: string, config?: Config): string;
  addHook(
    entryPoint: "afterSanitizeAttributes",
    hookFunction: AfterSanitizeAttributesHook,
  ): void;
};

export default DOMPurify;
