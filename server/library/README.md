# Exercise library

`exercises.json` is trimmed from `dist/exercises.json` of
[free-exercise-db](https://github.com/yuhonas/free-exercise-db) by yuhonas,
released into the public domain under the Unlicense. Kept per exercise: id,
name, force, level, mechanic, equipment, primary and secondary muscles,
category, the steps (`instructions`), and how many photos it has. The photos
are not in this repo: `server/library.js` fetches each from the project's
`exercises/<id>/<n>.jpg` the first time it is shown and keeps it under the data
directory (`exercise-img/`).

To refresh: download the project's `dist/exercises.json` and run the trim in
the commit that added this file (same fields, sorted by name).
