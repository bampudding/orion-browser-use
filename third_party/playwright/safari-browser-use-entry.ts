import { generateAriaTree, renderAriaTree } from './packages/injected/src/ariaSnapshot';
import { setGlobalOptions } from './packages/injected/src/domUtils';

export function snapshot(root: Element): string {
  setGlobalOptions({ browserNameForWorkarounds: 'webkit' });
  const options = { mode: 'default' as const };
  return renderAriaTree(generateAriaTree(root, options), options).text;
}
