"""Convert a fine-tuned model to the files the extension loads.

Usage: python training/export.py training/output/model training/output/export
It writes all-MiniLM-L6-v2/ inside the output folder, ready to copy into public/model/.
"""
import pathlib, shutil, subprocess, sys
from onnxruntime.quantization import QuantType, quantize_dynamic

model_dir, out_dir = sys.argv[1], pathlib.Path(sys.argv[2])
raw = out_dir / 'raw'
subprocess.run(['optimum-cli', 'export', 'onnx', '--model', model_dir,
                '--task', 'feature-extraction', str(raw)], check=True)

target = out_dir / 'all-MiniLM-L6-v2'
(target / 'onnx').mkdir(parents=True, exist_ok=True)
quantize_dynamic(str(raw / 'model.onnx'), str(target / 'onnx' / 'model_quantized.onnx'),
                 weight_type=QuantType.QInt8)
for name in ['config.json', 'tokenizer.json', 'tokenizer_config.json']:
    shutil.copy(raw / name, target / name)
print('ready:', target)
