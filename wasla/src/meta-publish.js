/**
 * Posting to the game's own Facebook Page and the Instagram professional account
 * linked to it, through Meta's Graph API with a Page access token.
 *
 * Every call takes the image by public URL — Meta fetches it — so the picture
 * must already be served (under /media/posts) when a call is made.
 *
 *   Facebook post    POST /{page}/photos { url, caption }
 *   Facebook story   POST /{page}/photos { url, published: false } → POST /{page}/photo_stories { photo_id }
 *   Instagram post   POST /{ig}/media { image_url, caption } → POST /{ig}/media_publish { creation_id }
 *   Instagram story  POST /{ig}/media { image_url, media_type: STORIES } → media_publish
 *
 * https://developers.facebook.com/docs/graph-api/reference/page/photos/
 * https://developers.facebook.com/docs/page-stories-api/
 * https://developers.facebook.com/docs/instagram-platform/content-publishing/
 */

export const GRAPH_VERSION = 'v26.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Where each post goes, in the order a slot posts them. */
export const TARGETS = {
  facebook_post: { network: 'facebook', size: 'square', label: 'منشور فيسبوك' },
  facebook_story: { network: 'facebook', size: 'story', label: 'قصة فيسبوك' },
  instagram_post: { network: 'instagram', size: 'square', label: 'منشور إنستغرام' },
  instagram_story: { network: 'instagram', size: 'story', label: 'قصة إنستغرام' },
};

/** A Graph API refusal, with Meta's own message. */
export class MetaError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = 'MetaError';
    this.code = code;
    this.status = status;
  }
}

/** How long an Instagram container gets to be ready, and how often it is asked. */
const CONTAINER_TRIES = 10;
const CONTAINER_WAIT_MS = 3000;

export function createMetaClient({ fetch = globalThis.fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  async function call(method, pathname, token, params = {}) {
    const url = new URL(`${GRAPH}/${pathname}`);
    const body = new URLSearchParams({ ...params, access_token: token });
    let response;
    try {
      response = method === 'GET'
        ? await fetch(`${url}?${body}`, { method })
        : await fetch(url, { method, body });
    } catch (err) {
      throw new MetaError(`تعذّر الوصول إلى Meta: ${err.message}`);
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // A body that is not JSON is reported by status below.
    }
    if (!response.ok || data?.error) {
      const error = data?.error ?? {};
      throw new MetaError(error.message || `Meta refused the request (${response.status}).`, { code: error.code ?? null, status: response.status });
    }
    return data ?? {};
  }

  /**
   * Checks a Page token: the Page it belongs to and its linked Instagram account.
   * A user token reads as a person, not a Page, and is refused here.
   */
  async function inspect(token) {
    const me = await call('GET', 'me', token, { fields: 'id,name' });
    if (!me.id) throw new MetaError('Meta did not say which Page this key belongs to.');
    let page;
    try {
      page = await call('GET', me.id, token, { fields: 'instagram_business_account{id,username}' });
    } catch (err) {
      // Asked of a person, Meta answers that a User has no such field.
      if (/node type \(User\)/i.test(err.message)) {
        throw new MetaError('هذا مفتاح حسابك الشخصي، لا مفتاح الصفحة: خذ access_token الصفحة من /me/accounts.');
      }
      throw err;
    }
    const instagram = page.instagram_business_account ?? null;
    return { pageId: me.id, pageName: me.name ?? '', igUserId: instagram?.id ?? null, igUsername: instagram?.username ?? null };
  }

  async function facebookPost({ pageId, token }, { imageUrl, caption }) {
    const photo = await call('POST', `${pageId}/photos`, token, { url: imageUrl, caption });
    const id = photo.post_id || photo.id;
    return { remoteId: id, link: id ? `https://www.facebook.com/${id}` : null };
  }

  async function facebookStory({ pageId, token }, { imageUrl }) {
    // A story needs a photo of its own that was never published as a post.
    const photo = await call('POST', `${pageId}/photos`, token, { url: imageUrl, published: 'false' });
    if (!photo.id) throw new MetaError('Meta did not return the story photo.');
    const story = await call('POST', `${pageId}/photo_stories`, token, { photo_id: photo.id });
    return { remoteId: story.post_id || photo.id, link: null };
  }

  /** An Instagram container, published once Meta says it is ready. */
  async function instagramPublish({ igUserId, token }, params) {
    if (!igUserId) throw new MetaError('لا حساب إنستغرام مرتبط بالصفحة.');
    const container = await call('POST', `${igUserId}/media`, token, params);
    if (!container.id) throw new MetaError('Meta did not return an Instagram container.');
    for (let i = 0; i < CONTAINER_TRIES; i++) {
      const { status_code: status } = await call('GET', container.id, token, { fields: 'status_code' });
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new MetaError(`Instagram could not take the image (${status}).`);
      if (i === CONTAINER_TRIES - 1) throw new MetaError('Instagram took too long to prepare the image.');
      await wait(CONTAINER_WAIT_MS);
    }
    const media = await call('POST', `${igUserId}/media_publish`, token, { creation_id: container.id });
    let link = null;
    try {
      ({ permalink: link = null } = await call('GET', media.id, token, { fields: 'permalink' }));
    } catch {
      // The post is up; only its link could not be read.
    }
    return { remoteId: media.id, link };
  }

  const instagramPost = (account, { imageUrl, caption }) => instagramPublish(account, { image_url: imageUrl, caption });
  const instagramStory = (account, { imageUrl }) => instagramPublish(account, { image_url: imageUrl, media_type: 'STORIES' });

  const publishers = { facebook_post: facebookPost, facebook_story: facebookStory, instagram_post: instagramPost, instagram_story: instagramStory };

  /** Posts one target; `{ remoteId, link }` or throws a MetaError. */
  function publish(target, account, content) {
    const publisher = publishers[target];
    if (!publisher) throw new MetaError(`Unknown target: ${target}`);
    return publisher(account, content);
  }

  return { inspect, publish };
}
