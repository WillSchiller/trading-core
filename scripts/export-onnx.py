import xgboost as xgb
import numpy as np
from sklearn.datasets import make_classification

model = xgb.XGBClassifier()
model.load_model('/tmp/pm_scorer_model.json')

# Export as XGBoost JSON (onnxruntime-node can't load XGBoost ONNX easily)
# Instead, export the raw model as JSON that we can load in TypeScript via xgboost-node
# Actually simplest: just save the model as JSON and use a pure-JS scorer

# Get the trees as JSON
model.save_model('/tmp/pm_scorer_model.json')

# Also export as simple lookup: for each feature combination, what's the prediction?
# Better approach: export model params so we can reconstruct in TypeScript
import json

booster = model.get_booster()
config = json.loads(booster.save_config())
print(f"Model type: {config['learner']['learner_model_param']['num_class']}")
print(f"Num trees: {config['learner']['gradient_booster']['gbtree_model_param']['num_trees']}")
print(f"Num features: {config['learner']['learner_model_param']['num_feature']}")

# Save as binary format that xgboost npm package can load
model.save_model('/Users/will/dev/blockhelix/models/pm_scorer.json')
print('Model saved to models/pm_scorer.json')

# Also save features list
features = [
    'entry_price', 'price_dist_from_half', 'implied_edge',
    'cat_sports', 'cat_crypto', 'cat_politics',
    'hour', 'dow',
    'size_vs_median',
    'roll_wr_20', 'roll_pf_20', 'roll_streak',
    'lifetime_wr', 'lifetime_pf', 'trade_num',
    'market_trader_count',
]
with open('/Users/will/dev/blockhelix/models/pm_scorer_features.json', 'w') as f:
    json.dump(features, f, indent=2)
print('Features saved to models/pm_scorer_features.json')
