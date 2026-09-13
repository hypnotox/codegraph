# Robot Framework language tables

`src/extraction/robot-languages.json` contains static header, setting and BDD-prefix
translations derived from Robot Framework's `src/robot/conf/languages.py`.
The JSON records the upstream repository, exact revision and copyright notice.
The Apache 2.0 license is retained here and copied beside the distributed table.

To regenerate from a local upstream checkout without importing Robot Framework:

```sh
python3 scripts/update-robot-languages.py /path/to/robotframework
```
