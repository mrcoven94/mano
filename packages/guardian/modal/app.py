# Mano guardian model server: Muse Glimmer (FP8) on one L40S, served with
# vLLM behind an OpenAI-compatible endpoint with Bearer auth.
#
# Production deploys run only through .github/workflows/guardian-modal.yml on
# merge to main. Never run `modal deploy` from a laptop for production.
#
# The endpoint scales to zero when idle. Every request needs
# Authorization: Bearer <MANO_GUARDIAN_TOKEN>.
import os
import subprocess

import modal

MODEL_ID = "RedHatAI/Muse-Glimmer-30B-FP8-block"
VLLM_IMAGE = "vllm/vllm-openai:v0.32.0"

app = modal.App("mano-guardian")

cache = modal.Volume.from_name("mano-guardian-cache", create_if_missing=True)
image = modal.Image.from_registry(VLLM_IMAGE)


@app.function(
    image=image,
    volumes={"/root/.cache/huggingface": cache},
    timeout=3600,
)
def download():
    """Snapshot the weights into the cache volume without a GPU."""
    from huggingface_hub import snapshot_download

    snapshot_download(repo_id=MODEL_ID)
    cache.commit()


@app.function(
    image=image,
    gpu="L40S",
    cpu=4.0,
    memory=32768,
    volumes={"/root/.cache/huggingface": cache},
    secrets=[modal.Secret.from_name("mano-guardian")],
    timeout=1800,
    min_containers=0,
    max_containers=1,
    scaledown_window=60,
    allow_concurrent_inputs=8,
)
@modal.web_server(port=8000, startup_timeout=1800)
def serve():
    token = os.environ["MANO_GUARDIAN_TOKEN"]
    subprocess.Popen(
        [
            "vllm",
            "serve",
            MODEL_ID,
            "--host",
            "0.0.0.0",
            "--port",
            "8000",
            "--api-key",
            token,
            "--gpu-memory-utilization",
            "0.90",
            "--max-model-len",
            "8192",
            "--generation-config",
            "auto",
            "--disable-log-requests",
        ]
    )
