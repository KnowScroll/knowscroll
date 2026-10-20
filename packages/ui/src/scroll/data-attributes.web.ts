/** Web: `data-ks-block` names the block and `data-ks-offset` the UTF-16 offset a run of text starts at. */
export function passageAttributes(blockId: string, offset: number): Record<string, unknown> {
  return { dataSet: { ksBlock: blockId, ksOffset: String(offset) } };
}

export function blockAttributes(blockId: string): Record<string, unknown> {
  return { dataSet: { ksBlock: blockId } };
}
