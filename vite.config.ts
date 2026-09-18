import { defineConfig, loadEnv, type Plugin, type Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
// Plain ESM module shared with the production servers.
import { handleMapboxToken } from './server/mapbox-token.mjs';

/**
 * Serves /api/mapbox-token from the dev and preview servers using the exact
 * handler that runs in production. Tokens are read from .env.local on the
 * server side only; nothing without the VITE_ prefix reaches the bundle.
 */
function mapboxTokenEndpoint(env: Record<string, string>): Plugin {
  const middleware: Connect.NextHandleFunction = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: Connect.NextFunction,
  ) => {
    const path = (req.url ?? '').split('?')[0];
    if (!path.endsWith('/api/mapbox-token')) return next();
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }
      const request = new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), {
        method: req.method,
        headers,
      });
      const response: Response = await handleMapboxToken(request, env);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      next(error);
    }
  };

  return {
    name: 'mapbox-token-endpoint',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

/**
 * Start downloading the map while the HTML is still being parsed.
 *
 * The map code is a dynamic import, so by default the browser only discovers
 * it after the entry script has downloaded and run, and discovers mapbox's
 * worker only after that code has run too: three round trips in a row. These
 * hints put all of it on the wire in parallel with the entry script.
 */
function preloadMap(): Plugin {
  return {
    name: 'preload-map',
    apply: 'build',
    transformIndexHtml(_html, ctx) {
      const bundle = ctx.bundle;
      if (!bundle) return [];
      const chunks = Object.values(bundle).filter((item) => item.type === 'chunk');
      const storyMap = chunks.find((chunk) => chunk.facadeModuleId?.replace(/\\/g, '/').endsWith('/src/map/story-map.ts'));
      if (!storyMap) return [];

      const entry = chunks.find((chunk) => chunk.isEntry)?.fileName;
      // The map chunk and everything it statically imports. mapbox-gl and the map
      // code shared with the route game sit in their own chunks, one level or more down.
      const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const graph = new Set<(typeof chunks)[number]>();
      const visit = (chunk: (typeof chunks)[number] | undefined) => {
        if (!chunk || chunk.fileName === entry || graph.has(chunk)) return;
        graph.add(chunk);
        chunk.imports.forEach((file) => visit(byFile.get(file)));
      };
      visit(storyMap);

      const scripts = new Set([
        ...[...graph].map((chunk) => chunk.fileName),
        // mapbox-gl imports its small debug chunk on every start; its 3D/Standard-style chunks are never used here.
        ...[...graph].flatMap((chunk) => chunk.dynamicImports).filter((file) => /(^|\/)debug-[\w-]+\.js$/.test(file)),
      ]);
      const styles = new Set([...graph].flatMap((chunk) => [...(chunk.viteMetadata?.importedCss ?? [])]));
      const worker = Object.keys(bundle).find((file) => /(^|\/)worker-[\w-]+\.js$/.test(file));

      return [
        ...[...scripts].map((file) => ({
          tag: 'link',
          attrs: { rel: 'modulepreload', href: `./${file}`, crossorigin: '' },
          injectTo: 'head' as const,
        })),
        ...[...styles].map((file) => ({
          tag: 'link',
          attrs: { rel: 'preload', as: 'style', href: `./${file}`, crossorigin: '' },
          injectTo: 'head' as const,
        })),
        // Fetched into the HTTP cache; mapbox starts its workers from there (no second
        // download). Chrome may log "preloaded but not used": there is no `as` value for
        // workers, so it cannot see the match. The warning is harmless.
        ...(worker
          ? [
              {
                tag: 'link',
                attrs: { rel: 'preload', as: 'fetch', href: `./${worker}`, crossorigin: '' },
                injectTo: 'head' as const,
              },
            ]
          : []),
      ];
    },
  };
}

/**
 * Preload both typefaces' Latin files: the hero title is the page's largest
 * paint, the loading screen's line is set in the sans, and the story is only
 * revealed once both are in (see main.ts). Found only through the stylesheet,
 * they would start a round trip later.
 */
function preloadFonts(): Plugin {
  return {
    name: 'preload-fonts',
    apply: 'build',
    transformIndexHtml(_html, ctx) {
      const files = Object.keys(ctx.bundle ?? {}).filter((name) =>
        /(newsreader|libre-franklin)-latin-wght-normal-.*\.woff2$/.test(name),
      );
      // The headline face first.
      files.sort((a, b) => Number(b.includes('newsreader')) - Number(a.includes('newsreader')));
      return files.map((file) => ({
        tag: 'link',
        attrs: { rel: 'preload', href: `./${file}`, as: 'font', type: 'font/woff2', crossorigin: '' },
        injectTo: 'head-prepend' as const,
      }));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    // Relative asset URLs: the build works from any sub-directory.
    base: './',
    plugins: [mapboxTokenEndpoint(env), preloadMap(), preloadFonts()],
    optimizeDeps: {
      // mapbox-gl's ESM build spawns its worker via new URL(..., import.meta.url);
      // pre-bundling would break that path in dev.
      exclude: ['mapbox-gl'],
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      cssCodeSplit: true,
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 900,
    },
    server: {
      port: 5173,
    },
  };
});
