# Training

## Fine-tuning the language model

Threadline ships `all-MiniLM-L6-v2`, a pretrained sentence-embedding network, unchanged.
These scripts fine-tune it and convert the result into the files the extension
loads. **Neither fine-tuned model has beaten the pretrained one on tabs yet**, so
measure before you ship one.

## Steps

Training takes 12 to 15 minutes on an M4 Mac. Use Python 3.12, and run everything
from the project root.

**1. Fine-tune.**

```bash
python3.12 -m venv .venv-train
.venv-train/bin/pip install -r training/requirements.txt
.venv-train/bin/python training/finetune.py --strategy sibling --out training/output/model
```

**2. Convert it.** Export needs older library versions, so it gets its own environment.

```bash
python3.12 -m venv .venv-export
.venv-export/bin/pip install -r training/requirements-export.txt
PATH="$PWD/.venv-export/bin:$PATH" python training/export.py training/output/model training/output/export
```

**3. Try it in the extension.**

```bash
cp -R training/output/export/all-MiniLM-L6-v2 public/model/
npm run eval:model
npm run build:verify
```

Then reload the extension. The similarity scale changes with fine-tuning, so also
re-check `SAME_TOPIC_SIMILARITY` in `src/ml/clusterer.js`.

## Results so far

Trained on [DBPedia Classes](https://huggingface.co/datasets/DeveloperOats/DBPedia_Classes):
240,000 Wikipedia abstracts in 219 categories. Articles about the test pages were removed.
The test set is 49 real pages on 5 pairs of close topics (such as WWI vs WWII),
with 5 tabs from each topic.

| Model | Held-out DBPedia categories | Close topics: chain keeps both topics unbroken |
| --- | ---: | ---: |
| Pretrained | 0.879 | **80%** |
| Fine-tuned, `broad` | 0.961 | 60% |
| Fine-tuned, `sibling` | 0.954 | 60% |

Both got much better at the task they trained on and worse at tabs. DBPedia's
categories are things like "Manga" and "Governor", so the model learns entity types,
which is not how people group tabs. Better training data is the next thing to try:
labelled browsing sessions, or text pairs from pages people actually read together.

## The category network

`train_categories.py` trains a small network on top of the language model, using
`dmoz.csv` (1.2M website titles and descriptions, available as a Kaggle download):

```bash
.venv-train/bin/python training/train_categories.py ~/Downloads/archive-2/dmoz.csv training/output/category_network.json
```

It takes a few minutes, and reached 84% on held-out `dmoz.csv` text. **It isn't used**,
because on real sites it lost clearly:

| Method | Held-out real sites (40) |
| --- | ---: |
| Written category descriptions | **90%** |
| Descriptions, with a little of the network blended in | 90% |
| Trained network | 63% |

dmoz has no labels for social media or streaming, so the network scored 0 of 4 on
each. A dataset with those labels would be the thing to try next.
