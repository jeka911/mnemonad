# mnemonad-search-transformers

Optional neural embedding models for [mnemonad-cli](https://www.npmjs.com/package/mnemonad-cli)'s
vector search — MiniLM (`Xenova/all-MiniLM-L6-v2`) by default, or any other
[transformers.js](https://huggingface.co/docs/transformers.js) feature-extraction model — run
locally on ONNX Runtime. No API key; nothing is sent anywhere.

mnemonad-cli's built-in model (potion-base-8M, static embeddings in plain JS) is small and fast,
but weaker on paraphrased queries. This package is the upgrade, kept separate because ONNX Runtime
is about 450 MB installed.

```bash
npm install -g mnemonad-cli mnemonad-search-transformers

mnemonad index ~/my-data --model minilm
mnemonad search ~/my-data "how does the key get derived"
```

The CLI finds this package on its own, whether both are installed globally, locally in one
project, or together through `npx -p mnemonad-cli -p mnemonad-search-transformers mnemonad …`.
An index built with MiniLM records that, so `search` (and a later `index`) uses MiniLM without
`--model`. Switch an index back to the built-in model with `mnemonad index <path> --rebuild`.

It has no dependency on mnemonad-cli. The two agree on a small interface (`apiVersion`,
`createProvider()`), which the CLI checks, so a version mismatch gets a clear message.

See [docs/search.md](https://github.com/jeka911/mnemonad/blob/main/docs/search.md) for how search
works, and how MiniLM compares with the built-in model.

License: AGPL-3.0.
