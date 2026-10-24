/**
 * The key of a Scroll ordered from code: `order-` and the order's UUID without dashes. It is the
 * production job's recipe key, so the job queue, the take rules and the job table treat an order
 * exactly as they treat a library recipe.
 */
export type MadeToOrderKey = `order-${string}`;
export const MADE_TO_ORDER_KEY = /^order-[0-9a-f]{32}$/;

export const madeToOrderKey = (orderId: string): MadeToOrderKey => `order-${orderId.replaceAll('-', '').toLowerCase()}`;
export const isMadeToOrderKey = (key: string): key is MadeToOrderKey => MADE_TO_ORDER_KEY.test(key);
