# Third-party notices and inventory

This inventory covers modules and font assets observed in a production Source build. Licence texts copied from installed package distributions are in `licenses/`; project code is under the root MIT licence. Re-run the production module inventory when dependencies change.

**Licence grants and remaining notices:** the locked npm artifacts declare MIT for `@antv/algorithm` 0.1.26, `@antv/event-emitter` 0.1.3 and `@antv/g-lite` 2.7.0, and ISC for nested `@antv/util` 2.0.17. These are published licence declarations; a missing licence file does not mean there is no licence grant. The exact versions, registry metadata, installed metadata and lockfile integrity values are recorded in [antv-locked-artifacts.json](antv-locked-artifacts.json). The exact upstream copyright notices are not present in those artifacts or otherwise verified. The [MIT](licenses/SPDX-MIT-reference.txt) and [ISC](licenses/SPDX-ISC-reference.txt) SPDX templates are reference texts, not package-specific copyright notices. In particular, the MIT licence of `@antv/util` v3 is not a substitute for the ISC licence declared by v2.

The locked `@antv/layout` 2.0.0 artifact declares MIT, includes its licence and identifies upstream commit `62bb4792b3ab948e096f9e17cfcb0f5c51ad9545`. Its generated vendored JavaScript has source maps containing original upstream source. The [source comparison](layout-vendored-source-comparison.json) and [matched published artifacts](layout-matched-artifacts.json) record the byte comparisons and exact tarball integrity values. Upstream licence texts for the matched historical artifacts are preserved in `licenses/`.

| Package | Installed version | Declared licence | Evidence status |
|---|---|---|---|
| @antv/algorithm | 0.1.26 | MIT | package omits licence text |
| @antv/component | 2.1.11 | MIT | license text copied |
| @antv/event-emitter | 0.1.3 | MIT | vendor embedded version unverified |
| @antv/expr | 1.0.2 | MIT | vendor embedded version unverified |
| @antv/g | 6.3.1 | MIT | license text copied |
| @antv/g-canvas | 2.2.0 | MIT | license text copied |
| @antv/g-lite | 2.7.0 | MIT | package omits licence text |
| @antv/g-math | 3.1.0 | MIT | license text copied |
| @antv/g-plugin-dragndrop | 2.1.1 | MIT | license text copied |
| @antv/g6 | 5.1.1 | MIT | license text copied |
| @antv/graphlib | 2.0.4 | MIT | license text copied |
| @antv/hierarchy | 0.7.1 | MIT | license text copied |
| @antv/layout | 2.0.0 | MIT | license text copied |
| @antv/scale | 0.4.16 | MIT | license text copied |
| @antv/util | 3.3.11 | MIT | vendor embedded version unverified |
| @babel/runtime | 7.29.7 | MIT | license text copied |
| @fontsource/dm-mono | 5.3.0 | OFL-1.1 | license text copied |
| @fontsource/ibm-plex-mono | 5.2.7 | OFL-1.1 | license text copied |
| @fontsource/jost | 5.3.0 | OFL-1.1 | license text copied |
| @fontsource/space-mono | 5.3.0 | OFL-1.1 | license text copied |
| @radix-ui/colors | 3.0.0 | MIT | license text copied |
| bubblesets-js | 2.3.4 | MIT | license text copied |
| color-name | 1.1.4 | MIT | license text copied |
| color-string | 1.9.1 | MIT | license text copied |
| comlink | 4.4.2 | Apache-2.0 | vendor embedded version unverified |
| d3-binarytree | 1.0.2 | MIT | vendor embedded version unverified |
| d3-dispatch | 3.0.1 | ISC | vendor embedded version unverified |
| d3-force | 3.0.0 | ISC | vendor embedded version unverified |
| d3-force-3d | 3.0.6 | MIT | vendor embedded version unverified |
| d3-octree | 1.1.0 | MIT | vendor embedded version unverified |
| d3-quadtree | 3.0.1 | ISC | vendor embedded version unverified |
| d3-timer | 3.0.1 | ISC | vendor embedded version unverified |
| dagre | 0.8.5 | MIT | vendor embedded version unverified |
| eventemitter3 | 5.0.4 | MIT | license text copied |
| gl-matrix | 3.4.4 | MIT | license text copied |
| graphlib | 2.1.8 | MIT | vendor embedded version unverified |
| html2canvas | 1.4.1 | MIT | license text copied |
| is-any-array | 3.0.0 | MIT | vendor embedded version unverified |
| is-arrayish | 0.3.4 | MIT | license text copied |
| lodash | 4.18.1 | MIT | vendor embedded version unverified |
| ml-array-max | 2.0.0 | MIT | vendor embedded version unverified |
| ml-array-min | 2.0.0 | MIT | vendor embedded version unverified |
| ml-array-rescale | 2.0.0 | MIT | vendor embedded version unverified |
| ml-matrix | 6.14.0 | MIT | vendor embedded version unverified |
| react | 19.2.7 | MIT | license text copied |
| react-dom | 19.2.7 | MIT | license text copied |
| scheduler | 0.27.0 | MIT | license text copied |
| simple-swizzle | 0.2.4 | MIT | license text copied |
| tslib | 2.8.1 | 0BSD | vendor embedded version unverified |
| vite | 7.3.6 | MIT | license text copied |
| @antv/util | 2.0.17 | ISC | package omits licence text |

## Upstream provenance for missing notices

- [`@antv/algorithm` 0.1.26](https://www.npmjs.com/package/@antv/algorithm/v/0.1.26) declares MIT. Its npm `gitHead` is `58b99ab9c937b8ec3e5e99b57624ad5a007682e5`; the package and [upstream tree at that commit](https://github.com/antvis/algorithm/tree/58b99ab9c937b8ec3e5e99b57624ad5a007682e5) do not supply a licence-named file.
- [`@antv/event-emitter` 0.1.3](https://www.npmjs.com/package/@antv/event-emitter/v/0.1.3) declares MIT. Its npm `gitHead` is `f46ff7712f332ef1c8b7601eb88b5784ad4edaa1`; the package and [upstream tree at that commit](https://github.com/antvis/event-emitter/tree/f46ff7712f332ef1c8b7601eb88b5784ad4edaa1) do not supply a licence-named file.
- [`@antv/g-lite` 2.7.0](https://www.npmjs.com/package/@antv/g-lite/v/2.7.0) declares MIT and names the [G repository](https://github.com/antvis/G), but its npm metadata has no `gitHead` and its package has no licence file. A neighbouring package's copyright text is not proof of this release's notice.
- Nested [`@antv/util` 2.0.17](https://www.npmjs.com/package/@antv/util/v/2.0.17) declares ISC and names the [util repository](https://github.com/antvis/util), but its package has no licence file or npm `gitHead`.

These package declarations identify the applicable licences; the remaining uncertainty is the package-specific copyright notice and complete attribution when compiled code is redistributed. The source checkout does not include these dependencies. A prebuilt wheel does; its distribution remains on hold while the missing notices are checked. An upstream maintainer can supply authoritative notice text. G-lite is part of G6’s renderer, so replacing it would substantially change the application.

## Layout source-map differences

All eight previously unmatched source-map entries correspond to generated or transformed `@antv/layout` output. Their source-map `sourcesContent` matches the named files in the following published npm artifacts:

| Sources | Matching published artifact | Licence |
|---|---|---|
| lodash `_baseOrderBy.js`, `_setCacheHas.js` | 4.17.20, 4.17.21 and 4.17.23 all match both files | MIT; the licence notices in those artifacts are byte-identical |
| `ml-matrix/matrix.js` | 6.12.1 | MIT |
| `tslib/tslib.es6.js` | 2.8.1 | 0BSD; the earlier discrepancy was newline normalization, not a different source |
| `is-any-array/lib-esm/index.js` | 2.0.1 | MIT |
| `ml-array-max/lib-es6/index.js` | 1.2.4 | MIT |
| `ml-array-min/lib-es6/index.js` | 1.2.3 | MIT |
| `ml-array-rescale/lib-es6/index.js` | 1.3.7 | MIT |

The matching tarball licence files, metadata and integrity hashes are in [layout-matched-artifacts.json](layout-matched-artifacts.json). After `npm ci`, `python3 scripts/inspect_layout_provenance.py` repeats the bounded registry comparison, and `python3 scripts/extract_layout_notices.py` obtains the matching published licence texts. `python3 scripts/verify_antv_artifacts.py` rechecks the five locked AntV artifacts. Matching a source file does not prove a unique build version; the relevant notice texts are retained without making that claim.
