// Shopify webhooks: orders/create -> attribute purchases to a live.
// The live id travels with the cart as the hidden cart attribute
// "_finafransar_live" (and as line item property "_live").
import { readBody, sendJson, HttpError } from '../lib/http.js';
import { verifyWebhook } from '../shopify/index.js';
import { isLiveId } from '../lib/sanitize.js';
import { recordOrder } from '../services/lives.js';

export function registerWebhookRoutes(router) {
  router.post('/webhooks/orders-create', async (req, res) => {
    const raw = await readBody(req, 2 * 1024 * 1024);
    if (!verifyWebhook(raw, req.headers['x-shopify-hmac-sha256'])) throw new HttpError(401, 'invalid_hmac');
    let order;
    try {
      order = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_json');
    }
    const fromAttr = (order.note_attributes || []).find((a) => a.name === '_finafransar_live')?.value;
    const fromLine = (order.line_items || [])
      .flatMap((li) => li.properties || [])
      .find((p) => p.name === '_live')?.value;
    const liveId = [fromAttr, fromLine].find((v) => isLiveId(v));
    if (liveId) {
      recordOrder({
        orderId: order.id,
        liveId,
        total: order.current_total_price ?? order.total_price,
        currency: order.currency,
        customerId: order.customer?.id,
      });
    }
    sendJson(res, 200, { ok: true });
  });
}
