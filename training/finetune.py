"""Fine-tune all-MiniLM-L6-v2 on DBPedia's labelled Wikipedia abstracts.

Whole categories are held out of training, and scoring uses only those, so the
"before" and "after" numbers are on topics the model never trained on.

  --strategy broad    pulls texts from the same fine category together
  --strategy sibling  also pushes apart sibling categories in the same family

See training/README.md, including why neither result ships yet.
"""
import argparse, collections, random
import numpy as np, torch
from datasets import Dataset, load_dataset
from sentence_transformers import (SentenceTransformer, SentenceTransformerTrainer,
                                   SentenceTransformerTrainingArguments, losses)

parser = argparse.ArgumentParser()
parser.add_argument('--strategy', choices=['broad', 'sibling'], default='sibling')
parser.add_argument('--examples', type=int, default=24000)
parser.add_argument('--lr', type=float, default=1e-5)
parser.add_argument('--batch-size', type=int, default=32)
parser.add_argument('--out', default='training/output/model')
args = parser.parse_args()

SEED = 7
random.seed(SEED); np.random.seed(SEED); torch.manual_seed(SEED)

data = load_dataset('DeveloperOats/DBPedia_Classes', split='train')
families = collections.defaultdict(lambda: collections.defaultdict(list))
for text, l2, l3 in zip(data['text'], data['l2'], data['l3']):
    families[l2][l3].append(text[:300])

# Hold out whole families of categories, so "unseen" really means unseen.
multi = sorted(f for f, cats in families.items() if len(cats) >= 2)
random.shuffle(multi)
held, train = multi[:10], multi[10:]
print('held-out families:', held)


def make_examples():
    rows = []
    for _ in range(args.examples):
        family = random.choice(train)
        cat, other = random.sample(sorted(families[family]), 2)
        anchor, positive = random.sample(families[family][cat], 2)
        row = {'anchor': anchor, 'positive': positive}
        if args.strategy == 'sibling':
            row['negative'] = random.choice(families[family][other])
        rows.append(row)
    return Dataset.from_list(rows)


def sibling_accuracy(model, per_category=25):
    """Is a text's nearest neighbour from the same category, among its siblings?"""
    rng, scores = random.Random(1), []
    for family in held:
        texts, labels = [], []
        for i, cat in enumerate(sorted(families[family])):
            sample = rng.sample(families[family][cat], min(per_category, len(families[family][cat])))
            texts += sample
            labels += [i] * len(sample)
        vectors = model.encode(texts, normalize_embeddings=True, show_progress_bar=False, batch_size=128)
        labels = np.array(labels)
        similarity = vectors @ vectors.T
        np.fill_diagonal(similarity, -9)
        scores.append((labels[similarity.argmax(1)] == labels).mean())
    return round(float(np.mean(scores)), 4)


model = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')
model.max_seq_length = 128
print('before, on held-out categories:', sibling_accuracy(model))

loss = (losses.TripletLoss(model, triplet_margin=0.2) if args.strategy == 'sibling'
        else losses.MultipleNegativesRankingLoss(model))
training_args = SentenceTransformerTrainingArguments(
    output_dir=args.out + '_checkpoints', num_train_epochs=1,
    per_device_train_batch_size=args.batch_size, learning_rate=args.lr,
    warmup_steps=50, logging_steps=100, save_strategy='no', report_to=[], seed=SEED,
    dataloader_drop_last=True)
SentenceTransformerTrainer(model=model, args=training_args, train_dataset=make_examples(), loss=loss).train()

print('after, on held-out categories:', sibling_accuracy(model))
model.max_seq_length = 256
model.save(args.out)
print('saved to', args.out)
