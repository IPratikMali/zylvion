---
title: "Linux 6.10: Rust Drivers Go Mainstream, New Memory Safety Subsystems"
description: "Linux 6.10 merges the first production Rust-based device drivers into mainline, alongside major improvements to the memory safety infrastructure Linus Torvalds approved for the kernel tree."
pubDate: 2026-06-08
author: "TechAudit Editorial Team"
tags: ["Open Source", "Security"]
---

Linux kernel 6.10 was tagged by Linus Torvalds this week, and the headline story is one that's been years in the making: Rust-based device drivers are now in mainline and shipping in production kernels. This represents a significant shift in kernel development culture and has meaningful implications for long-term memory safety.

## Rust in Mainline: What's Actually There

The Rust abstractions merged in 6.10 include:

- **PHY drivers**: The `phy-bcm84881` Rust driver for Broadcom PHY hardware ships as a direct replacement for the equivalent C driver, demonstrating feature parity
- **GPU subsystem abstractions**: Nova, the new Rust-based NVIDIA GSP firmware driver, is merged as an experimental driver replacing the older Nouveau approach
- **Filesystem utilities**: Rust abstractions for the VFS layer enabling safer filesystem driver development

The `rust/` directory now contains approximately 47,000 lines of Rust code plus 125,000 lines of binding abstractions. For context, the entire kernel is ~36 million lines, so Rust remains a small fraction, but the trajectory is clear.

## Why This Matters for Security

Memory corruption vulnerabilities — use-after-free, buffer overflows, integer overflows — account for roughly 70% of Linux kernel CVEs. Rust's ownership model makes entire classes of these bugs impossible to write: the compiler rejects code that could trigger UAF or buffer overflows at compile time rather than at runtime.

The kernel security team's analysis of memory-safety vulnerabilities from 2019-2023 shows:

| Vulnerability Class | % of Kernel CVEs |
|--------------------|--------------:|
| Use-after-free | 34% |
| Buffer overflow | 18% |
| Integer overflow | 11% |
| Race condition | 15% |
| Other memory | 7% |
| Logic bugs | 15% |

Rust eliminates the first two categories and reduces the third. If 50% of new kernel code were Rust within 10 years, the rough estimate is a 30-40% reduction in exploitable kernel vulnerabilities.

## The C Developer Reaction

The mailing list reaction to Rust integration has been predictably contentious. The core concerns from C maintainers are legitimate:

1. **Toolchain dependency**: Requiring Rust for kernel builds adds a significant toolchain dependency not all distributions manage well
2. **Abstraction costs**: Rust's zero-cost abstractions have non-zero cognitive overhead for developers trained on C
3. **Review burden**: Subsystem maintainers now need Rust expertise to review drivers

Torvalds' position — that Rust is "a reasonable second language for the kernel" but that C is not going anywhere — is the practical consensus.

## Other Notable Changes in 6.10

- **PREEMPT_RT merged**: The real-time preemption patchset, maintained out-of-tree for 20 years, is finally in mainline
- **AMD Zen 5 support**: Full support for AMD's next-generation CPU architecture
- **io_uring improvements**: Further async I/O performance improvements, particularly for NVMe workloads
- **Memory folios**: The folio conversion project (reducing page table overhead) continues its multi-year progress

The PREEMPT_RT merge is arguably as historically significant as Rust — it ends a 20-year maintenance burden on the real-time Linux community and brings RT capabilities to every distribution kernel.
