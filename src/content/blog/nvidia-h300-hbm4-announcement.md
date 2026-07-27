---
title: "NVIDIA H300 NVL Unveiled: 288GB HBM4, 2x H100 Bandwidth"
description: "NVIDIA's H300 NVL accelerator doubles HBM bandwidth and memory capacity over the H100, targeting trillion-parameter model inference and large-scale AI training clusters."
pubDate: 2026-06-11
author: "TechAudit Editorial Team"
tags: ["Hardware", "AI"]
---

NVIDIA officially unveiled the H300 NVL accelerator at its annual GTC event, targeting hyperscalers and national labs running trillion-parameter frontier AI models. The card ships with 288GB of HBM4 memory — a 2x increase over the H100's 80GB HBM2e — and delivers 9.8 TB/s of memory bandwidth.

## Key Specifications

| Feature | H300 NVL | H100 SXM5 | Delta |
|---------|----------|----------|-------|
| GPU Architecture | Blackwell+ | Hopper | — |
| Memory | 288GB HBM4 | 80GB HBM2e | +260% |
| Memory BW | 9.8 TB/s | 3.35 TB/s | +192% |
| FP8 Tensor | 8,000 TFLOPS | 3,958 TFLOPS | +102% |
| FP16 Tensor | 4,000 TFLOPS | 1,979 TFLOPS | +102% |
| NVLink BW | 1.8 TB/s | 900 GB/s | +100% |
| TDP | 1,200W | 700W | +71% |

## The Memory Story

The headline improvement is memory. HBM4 delivers wider die stacking (16-Hi vs 12-Hi) and faster interface speeds (8 Gbps/pin vs 3.2 Gbps/pin for HBM2e), enabling the bandwidth doubling. The 288GB capacity is enabled by 8-stack HBM4 packages.

For transformer inference, memory bandwidth is often the binding constraint — not compute. The bandwidth improvement means inference throughput for large models like Llama-3 405B should roughly double on H300 vs H100 in bandwidth-bound regimes.

## NVLink 6.0

NVLink 6.0 doubles the per-GPU bandwidth to 1.8 TB/s and scales to 576 GPUs in a single NVSwitch fabric domain, up from 256 GPUs. This matters for model parallelism at the scale of GPT-5 class models, where communication overhead across GPU boundaries becomes a significant constraint.

## Availability and Pricing

H300 NVL units are expected to reach hyperscalers in Q3 2026. List pricing is not disclosed; H100s currently trade at approximately $30,000-$35,000 on the secondary market. Analysts expect H300 initial pricing above $50,000 per GPU.

## Competitive Context

AMD's MI350X, announced earlier this year, targets similar specs but currently trails on software ecosystem maturity. Intel's Gaudi 4 has competitive pricing but continues to struggle with adoption outside Intel's own cloud.

For most AI workloads, NVIDIA's CUDA software moat remains the dominant purchasing factor regardless of raw hardware specs.
