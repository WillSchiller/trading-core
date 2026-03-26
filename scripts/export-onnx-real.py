import xgboost as xgb
import numpy as np
from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType

model = xgb.XGBClassifier()
model.load_model('/tmp/pm_scorer_model.json')

initial_type = [('features', FloatTensorType([None, 16]))]
onnx_model = convert_xgboost(model, initial_types=initial_type)

import onnx
onnx.save_model(onnx_model, '/Users/will/dev/blockhelix/models/pm_scorer.onnx')
print('ONNX model saved')

# Verify
import onnxruntime as ort
session = ort.InferenceSession('/Users/will/dev/blockhelix/models/pm_scorer.onnx')
test_input = np.random.rand(1, 16).astype(np.float32)
result = session.run(None, {'features': test_input})
print(f'Test prediction: {result[1][0]}')
