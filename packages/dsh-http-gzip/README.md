# dsh-http-gzip

A DSH host-plane plugin that negotiates Brotli, Zstandard, or gzip compression
for buffered, compressible Web responses. It preserves streaming, range,
already-encoded, `no-transform`, and incompressible responses and releases a
response uncompressed if its buffer exceeds the configured 1 GiB safety cap.

The source is strict TypeScript. Published packages contain compiled ESM and
declaration files under `lib/`.

