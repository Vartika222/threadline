"""Train the category network: a small classifier on top of all-MiniLM-L6-v2.

Usage: python training/train_categories.py ~/Downloads/archive-2/dmoz.csv public/model/category_network.json

dmoz.csv has website titles and descriptions with 13 categories, mapped below to
Threadline's. It has nothing for Social, and Entertainment only has Sports, so the
known sites list and category descriptions cover those (see src/ml/categories.js).
"""
import collections, csv, json, random, sys
import numpy as np, torch
from sentence_transformers import SentenceTransformer

SEED = 7
random.seed(SEED); np.random.seed(SEED); torch.manual_seed(SEED)
source, output = sys.argv[1], sys.argv[2]
PER_CLASS, EPOCHS = 30000, 25

MAPPING = {
    'Reference': 'Study', 'Science': 'Study',
    'Computers': 'Work', 'Business': 'Work',
    'Games': 'Games',
    'Sports': 'Entertainment',
    'Shopping': 'Shopping & Art', 'Arts': 'Shopping & Art',
    'News': 'News',
    'Health': 'Life & Other', 'Home': 'Life & Other', 'Recreation': 'Life & Other', 'Society': 'Life & Other',
}
LABELS = sorted(set(MAPPING.values()))

# Split by source category too, so one huge label can't crowd out its neighbours.
csv.field_size_limit(10**7)
by_source = collections.defaultdict(list)
with open(source, encoding='utf8', errors='replace', newline='') as f:
    for row in csv.DictReader(f):
        if row['category'] in MAPPING and row['title'] and row['desc']:
            by_source[row['category']].append(f"{row['title']}. {row['desc']}"[:300])

texts, labels = [], []
for label in LABELS:
    sources = [s for s, l in MAPPING.items() if l == label]
    for s in sources:
        random.shuffle(by_source[s])
        for text in by_source[s][:PER_CLASS // len(sources)]:
            texts.append(text); labels.append(LABELS.index(label))
print('examples', len(texts), collections.Counter(LABELS[l] for l in labels), flush=True)

model = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')
X = model.encode(texts, normalize_embeddings=True, batch_size=256, show_progress_bar=False)
y = np.array(labels)
order = np.random.permutation(len(y))
cut = int(len(y) * 0.9)
device = 'mps' if torch.backends.mps.is_available() else 'cpu'
X_train, y_train = torch.tensor(X[order[:cut]]).to(device), torch.tensor(y[order[:cut]]).to(device)
X_test, y_test = torch.tensor(X[order[cut:]]).to(device), torch.tensor(y[order[cut:]]).to(device)

net = torch.nn.Sequential(torch.nn.Linear(X.shape[1], 128), torch.nn.ReLU(), torch.nn.Dropout(0.2),
                          torch.nn.Linear(128, len(LABELS))).to(device)
optimiser = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-5)
loss_fn = torch.nn.CrossEntropyLoss()
for epoch in range(EPOCHS):
    net.train()
    for batch in torch.randperm(len(y_train), device=device).split(512):
        optimiser.zero_grad()
        loss_fn(net(X_train[batch]), y_train[batch]).backward()
        optimiser.step()
    if epoch % 5 == 0 or epoch == EPOCHS - 1:
        net.eval()
        with torch.no_grad():
            print(epoch, 'held-out dmoz accuracy', round((net(X_test).argmax(1) == y_test).float().mean().item(), 4), flush=True)

net.eval()
with torch.no_grad():
    predicted = net(X_test).argmax(1)
for i, label in enumerate(LABELS):
    print(label, round((predicted[y_test == i] == i).float().mean().item(), 3))

layers = [net[0], net[3]]
json.dump({
    'labels': LABELS,
    'layers': [{'weights': [[round(v, 5) for v in row] for row in l.weight.detach().cpu().tolist()],
                'bias': [round(v, 5) for v in l.bias.detach().cpu().tolist()]} for l in layers],
}, open(output, 'w'))
print('saved', output)
