/**
 * What search engines and link previews read about the public site: the
 * sitemap, robots.txt, each page's title and description, and the landing
 * page's structured data. Every address is absolute, on the site's own domain
 * (SITE_URL, or PUBLIC_URL when there is none), so crawlers and previews never
 * see the service domain the pages 301 away from.
 */

const SCREENSHOTS = ['shot-1', 'shot-2', 'shot-3', 'shot-4', 'shot-5', 'shot-6', 'shot-7'];

/** The public pages, in sitemap order, with the title and description each one wears. */
export const SITE_PAGES = Object.freeze([
  {
    path: '/',
    title: 'شبّك – لعبة كلمات متقاطعة عربية مجانية',
    description: 'شبّك لعبة كلمات متقاطعة عربية مجانية للآيفون والآيباد: أسئلة يكتبها بشر في أكثر من عشرين فئة، ولغز جديد كل يوم، ولوحات متصدرين.',
  },
  {
    path: '/privacy',
    title: 'سياسة الخصوصية',
    description: 'سياسة خصوصية لعبة شبّك: ما الذي تجمعه اللعبة، ولماذا، وكيف تحذفه. Shabbik privacy policy.',
  },
  {
    path: '/support',
    title: 'الدعم',
    description: 'الدعم والمساعدة في لعبة شبّك: أسئلة شائعة وطريقة التواصل معنا. Shabbik support.',
  },
  {
    path: '/credits',
    title: 'شكر الصور',
    description: 'أصحاب الصور المستعملة في لعبة شبّك وتراخيصها الحرة. Picture credits and licences for Shabbik.',
  },
]);

const trimBase = (base) => String(base).replace(/\/+$/, '');

/** The SEO fields of one public page, with its absolute canonical address. */
export function pageMeta(base, path) {
  const page = SITE_PAGES.find((p) => p.path === path);
  if (!page) throw new Error(`Not a public page: ${path}`);
  return { ...page, canonical: `${trimBase(base)}${path}` };
}

export function sitemapXml(base) {
  const root = trimBase(base);
  const urls = SITE_PAGES.map((p) => `  <url><loc>${root}${p.path}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(base) {
  return `User-agent: *\nDisallow: /admin\nDisallow: /api/\nAllow: /\n\nSitemap: ${trimBase(base)}/sitemap.xml\n`;
}

/**
 * JSON-LD for the landing page: the site, the app and its maker. No rating or
 * review is ever put here — Google penalises marked-up ratings that are not
 * real — so the app earns a rich result only once the store has its own.
 * Escaped so no text inside can end the <script> it sits in.
 */
export function landingJsonLd({ base, description, appStoreUrl }) {
  const root = trimBase(base);
  const org = { '@type': 'Organization', '@id': `${root}/#org`, name: 'Koydam', url: `${root}/`, email: 'support@koydam.com' };
  const app = {
    '@type': 'MobileApplication',
    '@id': `${root}/#app`,
    name: 'شبّك',
    alternateName: ['Shabbik', 'Chabbek'],
    description,
    url: `${root}/`,
    image: `${root}/assets/site/app-icon.png`,
    screenshot: SCREENSHOTS.map((s) => `${root}/assets/site/${s}.jpg`),
    operatingSystem: 'iOS',
    applicationCategory: 'GameApplication',
    applicationSubCategory: 'Word',
    inLanguage: 'ar',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@id': org['@id'] },
    ...(appStoreUrl ? { installUrl: appStoreUrl, sameAs: [appStoreUrl] } : {}),
  };
  const site = {
    '@type': 'WebSite', '@id': `${root}/#site`, name: 'شبّك', alternateName: ['Shabbik', 'Chabbek'],
    url: `${root}/`, inLanguage: 'ar', publisher: { '@id': org['@id'] },
  };
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': [site, org, app] })
    .replace(/</g, '\\u003c');
}
