import { getDynamicCSSRules } from '@iconify/tailwind4/lib/plugins/dynamic.js';
import plugin from 'tailwindcss/plugin';

// Thin wrapper around the dynamic half of @iconify/tailwind4.
//
// The package's main entry (lib/plugin.js) also pulls in @iconify/tools
// (SVGO and friends) for its preparsed / from-folder features, which this
// project does not use. Importing that graph dominated the CSS build
// time, so this file registers the same dynamic `icon` component the
// official plugin registers by default — same rule generator, same
// warn-and-continue behavior — without loading the tools graph.
//
// If @iconify/tailwind4 ever moves lib/plugins/dynamic.js, the build
// fails loudly on the import; point it at the new location then.
export default plugin(({ matchComponents }) => {
  matchComponents({
    icon: (icon) => {
      try {
        return getDynamicCSSRules(icon, {});
      } catch (err) {
        console.warn(err.message);
        return {};
      }
    },
  });
});
