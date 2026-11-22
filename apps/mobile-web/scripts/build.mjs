import fs from 'node:fs'
import path from 'node:path'
import esbuild from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.resolve(root, '..', 'relay', 'public', 'app')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(root, 'src/app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome100', 'safari15'],
  minify: true,
  sourcemap: false,
  outfile: path.join(outDir, 'app.js'),
  logLevel: 'info',
})

for (const file of ['index.html', 'style.css', 'manifest.webmanifest', 'icon.svg']) {
  fs.copyFileSync(path.join(root, 'src', file), path.join(outDir, file))
}
console.log(`mobile PWA -> ${outDir}`)
