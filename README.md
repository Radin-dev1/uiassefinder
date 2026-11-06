# UI Asset Finder

Find UI assets and references for your game or app from an image, a text description, or both. It searches **Pinterest, Dribbble, Behance, ArtStation, the Roblox DevForum and the whole web**, and also searches **your own folder of UI examples**.

## How it works

1. You give it a reference image, a description, or both.
2. Your chosen AI model looks at the input and writes a short brief, style tags, colours and 3 to 5 search queries.
3. It runs those queries on every site you selected through a real image-search API, so nothing is scraped.
4. If AI rerank is on, the model looks at the top results next to your reference and scores how well each one fits.
5. At the same time it searches your `examples/` folder and ranks the closest matches.
6. Click **+ Examples** on any web result to save it into your examples folder.

## Setup

```bash
npm install
npm start
```

Then open http://127.0.0.1:5177, go to **Settings**, and fill in:

| Setting | What to put |
|---|---|
| AI provider | Anthropic, OpenAI, Gemini, OpenRouter, Groq, or Custom (any OpenAI-compatible server such as Ollama or LM Studio) |
| API key | Your key for that provider |
| Model | Pick from the list, or press **Load models** to fetch every model your key can use. Choose one that can read images. |
| Search API | [Serper.dev](https://serper.dev) (free tier), [Brave Search API](https://brave.com/search/api/) or [SerpAPI](https://serpapi.com). Choose **No search key** to get one-click search links for each site instead of an image grid. |

Keys stay in your browser's localStorage. The local server passes them straight to the provider and never writes them to disk.

## Your UI examples folder

Put images (`png`, `jpg`, `webp`, `gif`) in `examples/`. Subfolders work, so you can sort them into `shops/`, `hud/`, `buttons/` and so on. You can also upload them from the **My examples** tab.

Press **Index new images** once. The AI describes and tags each image, and the results are cached in `examples/.index.json`. Only new or changed images are indexed again later.

To use a folder somewhere else:

```bash
EXAMPLES_DIR="D:/My UI refs" npm start
```

On PowerShell: `$env:EXAMPLES_DIR="D:\My UI refs"; npm start`

## Options

| Env var | Default | |
|---|---|---|
| `PORT` | `5177` | |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to open it on your network |
| `EXAMPLES_DIR` | `./examples` | Your UI examples folder |

Tips: paste an image straight from the clipboard with Ctrl+V, and press Ctrl+Enter in the text box to search.
