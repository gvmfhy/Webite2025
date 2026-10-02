// Keep the directly accessible Garden out of Quarto's public sitemap.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sitemapPath = join(process.env.QUARTO_PROJECT_OUTPUT_DIR || '_site', 'sitemap.xml');
const sitemap = readFileSync(sitemapPath, 'utf8');
const unlisted = sitemap.replace(/\s*<url>\s*[\s\S]*?<\/url>/g, (entry) => {
  const location = entry.match(/<loc>([^<]+)<\/loc>/)?.[1];
  return location && new URL(location).pathname.startsWith('/agent-garden/') ? '' : entry;
});
if (unlisted !== sitemap) writeFileSync(sitemapPath, unlisted);
