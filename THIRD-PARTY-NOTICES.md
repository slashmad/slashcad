# Third-party notices

SlashCAD 0.3.0-fix is MIT-licensed (see LICENSE). Its installers and archives also contain the
third-party software below, each under its own licence. Full licence texts are shipped with each component:
Python packages in `resources/python/…/site-packages/<name>-<version>.dist-info/`, CPython in
`resources/python/lib/python3.13/LICENSE.txt` (Windows: `resources/python/LICENSE.txt`), Electron and Chromium in
`LICENSE.electron.txt` and `LICENSES.chromium.html` next to the executable, and the texts in `licenses/`.

## Open CASCADE Technology (OCCT)

The geometry kernel used through `cadquery-ocp-novtk` (the `libTK*` shared libraries in `cadquery_ocp_novtk.libs`)
is Open CASCADE Technology, © OPEN CASCADE SAS, licensed under the GNU Lesser General Public License version 2.1
with the Open CASCADE exception version 1.0 (`licenses/LGPL-2.1.txt`, `licenses/OCCT-LGPL-exception-1.0.txt`).
It is linked dynamically; you may replace these libraries with your own build. Source code:
https://github.com/Open-Cascade-SAS/OCCT (version 8.0.1) and https://github.com/CadQuery/OCP for the bindings.

## Runtime

| Component | Licence |
|---|---|
| Electron 45.0.0 (incl. Chromium and Node.js) | MIT; Chromium: BSD-3-Clause and others (LICENSES.chromium.html) |
| CPython 3.13 (python-build-standalone, https://github.com/astral-sh/python-build-standalone) | PSF-2.0; bundled libraries such as OpenSSL, libffi, zlib, SQLite under their own licences (LICENSE.txt) |

## JavaScript packages (renderer)

| Package | Version | Licence |
|---|---|---|
| react | 19.1.10 | MIT |
| react-dom | 19.1.10 | MIT |
| scheduler | 0.26.0 | MIT |
| three | 0.186.1 | MIT |
| three-mesh-bvh | 0.9.16 | MIT |

## Python packages (CAD worker)

| Package | Version | Licence | Project |
|---|---|---|---|
| anytree | 2.13.0 | Apache-2.0 | https://github.com/c0fec0de/anytree |
| asttokens | 3.0.2 | Apache-2.0 | https://github.com/gristlabs/asttokens |
| bd_materials | 0.2.5 | Apache-2.0 | https://github.com/bernhard-42/bd_materials |
| build123d | 0.13.0 | Apache Software License | https://github.com/gumyr/build123d |
| cadquery-ocp-novtk | 8.0.1.1.0 | Apache Software License |  |
| cadquery-ocp-proxy | 8.0.1.1.0 | Apache Software License |  |
| certifi | 2026.10.23 | Mozilla Public License 2.0 (MPL 2.0) | https://github.com/certifi/python-certifi |
| charset-normalizer | 3.5.2 | MIT | https://github.com/jawah/charset_normalizer/blob/master/CHANGELOG.md |
| cloudpickle | 3.1.2 | BSD License | https://github.com/cloudpipe/cloudpickle |
| dataclasses-json | 0.6.7 | MIT License | https://github.com/lidatong/dataclasses-json |
| Deprecated | 3.0.1 | MIT | https://github.com/laurent-laporte-pro/deprecated |
| executing | 2.3.0 | MIT License | https://github.com/alexmojaki/executing |
| ezdxf | 1.4.5 | MIT License | https://github.com/mozman/ezdxf |
| fonttools | 4.68.0 | MIT | http://github.com/fonttools/fonttools |
| idna | 3.20 | BSD-3-Clause | https://github.com/kjd/idna/blob/master/HISTORY.md |
| ipython | 9.18.1 | BSD-3-Clause | https://ipython.org |
| ipython_pygments_lexers | 1.1.1 | BSD License | https://github.com/ipython/ipython-pygments-lexers |
| jedi | 0.20.1 | MIT License | https://github.com/davidhalter/jedi |
| joblib | 1.6.0 | BSD-3-Clause | https://joblib.readthedocs.io |
| lib3mf | 2.5.0 | BSD License |  |
| marshmallow | 3.26.2 | MIT License | https://marshmallow.readthedocs.io/en/latest/changelog.html |
| matplotlib-inline | 0.2.2 | BSD-3-Clause | https://github.com/ipython/matplotlib-inline |
| mpmath | 1.3.0 | BSD License | http://mpmath.org/ |
| mypy_extensions | 1.2.0 | MIT | https://github.com/python/mypy_extensions |
| narwhals | 2.28.0 | MIT | https://github.com/narwhals-dev/narwhals |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | https://numpy.org |
| ocp_gordon | 0.3.1 | Apache-2.0 | https://github.com/gongfan99/ocp_gordon |
| ocpsvg | 0.7.0 | Apache-2.0 |  |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause | https://packaging.pypa.io/ |
| parso | 0.8.7 | MIT License | https://github.com/davidhalter/parso |
| pexpect | 4.9.0 | ISC License (ISCL) | https://pexpect.readthedocs.io/ |
| pillow | 13.0.0 | MIT-CMU | https://pillow.readthedocs.io/en/stable/releasenotes/index.html |
| pip | 26.2.2 | MIT | https://pip.pypa.io/en/stable/news/ |
| platformdirs | 4.14.5 | MIT | https://platformdirs.readthedocs.io/en/latest/changelog.html |
| prompt_toolkit | 3.0.53 | BSD License | https://github.com/prompt-toolkit/python-prompt-toolkit |
| psutil | 7.2.2 | BSD-3-Clause | https://github.com/giampaolo/psutil |
| ptyprocess | 0.7.0 | ISC License (ISCL) | https://github.com/pexpect/ptyprocess |
| pure_eval | 0.2.4 | MIT License | http://github.com/alexmojaki/pure_eval |
| pygltflib | 1.16.5 | MIT License | https://gitlab.com/dodgyville/pygltflib |
| Pygments | 2.21.0 | BSD-2-Clause | https://pygments.org |
| pyparsing | 3.3.3 | MIT | https://pyparsing-docs.readthedocs.io/en/latest/ |
| requests | 2.34.2 | Apache Software License | https://requests.readthedocs.io |
| scikit-learn | 1.9.1 | BSD-3-Clause | https://scikit-learn.org |
| scipy | 1.18.1 | BSD License | https://scipy.org/ |
| stack-data | 0.6.3 | MIT License | http://github.com/alexmojaki/stack_data |
| svgelements | 1.9.6 | MIT License | https://github.com/meerk40t/svgelements |
| svgpathtools | 1.8.0 | MIT License | https://github.com/mathandy/svgpathtools |
| svgwrite | 1.4.3 | MIT License | http://github.com/mozman/svgwrite.git |
| sympy | 1.14.0 | BSD License | https://sympy.org |
| threadpoolctl | 3.8.0 | BSD-3-Clause | https://github.com/joblib/threadpoolctl |
| threejs-materials | 1.2.5 | Apache-2.0 | https://github.com/bernhard-42/threejs-materials |
| traitlets | 5.16.1 | BSD License | https://github.com/ipython/traitlets |
| trianglesolver | 1.2 | MIT License | http://pypi.python.org/pypi/trianglesolver |
| typing-inspect | 0.9.0 | MIT License | https://github.com/ilevkivskyi/typing_inspect |
| typing_extensions | 4.16.0 | PSF-2.0 | https://github.com/python/typing_extensions/issues |
| urllib3 | 2.8.0 | MIT | https://github.com/urllib3/urllib3/blob/main/CHANGES.rst |
| wcwidth | 0.9.4 | MIT License | https://github.com/jquast/wcwidth |
| webcolors | 24.8.0 | BSD License | https://webcolors.readthedocs.io |
| wrapt | 2.5.2 | BSD-2-Clause | https://github.com/GrahamDumpleton/wrapt |

SolidCraft, Claude Code and Codex are not bundled: the app uses the user's own installations.
