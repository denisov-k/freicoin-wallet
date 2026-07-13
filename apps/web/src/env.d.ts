// Vite injects import.meta.env at build time; declare it so checkJs stops flagging it.
interface ImportMeta { readonly env: Record<string, string | undefined>; }
