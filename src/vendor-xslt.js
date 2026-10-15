// Keep the optional LGPL engine external and independently replaceable.
// Its upstream types require browser globals; our facade uses this narrow tested bridge.
export function loadXslt() { return import('xslt-processor'); }
