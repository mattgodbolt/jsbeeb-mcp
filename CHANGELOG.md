# Changelog

## [2.1.0](https://github.com/mattgodbolt/jsbeeb-mcp/compare/v2.0.0...v2.1.0) (2026-03-17)


### Features

* Fix breakpoints, add disassembler ([2bd4d81](https://github.com/mattgodbolt/jsbeeb-mcp/commit/2bd4d81418b5e91306cb0e0ad9f4e18f2d93f8b7))

## [2.0.0](https://github.com/mattgodbolt/jsbeeb-mcp/compare/v1.2.1...v2.0.0) (2026-03-16)


### ⚠ BREAKING CHANGES

* set_breakpoint no longer runs the emulator. It installs a persistent breakpoint hook and returns immediately. run_for_cycles now resets hit flags before running and includes breakpoint hit info (with registers) in the response when one fires.

### Features

* redesign set_breakpoint as install-only, add clear_breakpoint ([23f94e5](https://github.com/mattgodbolt/jsbeeb-mcp/commit/23f94e5b732f8a6d5d9bafa08a5250668b5b4ca1))

## [1.2.1](https://github.com/mattgodbolt/jsbeeb-mcp/compare/v1.2.0...v1.2.1) (2026-03-15)


### Bug Fixes

* update lockfile for jsbeeb 1.5.0 ([e38341f](https://github.com/mattgodbolt/jsbeeb-mcp/commit/e38341f50d6ea9130b6d1a0ac39f8c736089f080))

## [1.2.0](https://github.com/mattgodbolt/jsbeeb-mcp/compare/v1.1.1...v1.2.0) (2026-03-15)


### Features

* add sound chip debugging tools ([2df70d0](https://github.com/mattgodbolt/jsbeeb-mcp/commit/2df70d03dbe77e6a8545277d43c25a586b099a04))

## [1.1.1](https://github.com/mattgodbolt/jsbeeb-mcp/compare/v1.1.0...v1.1.1) (2026-02-23)


### Bug Fixes

* don't wait for prompt after disc autoboot ([02ba3e6](https://github.com/mattgodbolt/jsbeeb-mcp/commit/02ba3e61e10254c106b7f27c04b4fc700d450f05))

## [1.1.0](https://github.com/mattgodbolt/jsbeeb-mcp/compare/v1.0.1...v1.1.0) (2026-02-23)


### Features

* add key_down, key_up, reset, boot_disc, and run_disc tools ([af798cc](https://github.com/mattgodbolt/jsbeeb-mcp/commit/af798cc33a370397e99d2a99fe07f9ea452a0473))

## [1.0.1](https://github.com/mattgodbolt/jsbeeb-mcp/compare/v1.0.0...v1.0.1) (2026-02-23)


### Bug Fixes

* require jsbeeb ^1.3.3 so ROMs are included when installed from npm ([593aad8](https://github.com/mattgodbolt/jsbeeb-mcp/commit/593aad875750c7b0c59040f128f4d40510577a53))

## 1.0.0 (2026-02-23)


### Features

* add npm publish via release-please and npx support ([643bdf2](https://github.com/mattgodbolt/jsbeeb-mcp/commit/643bdf28b51d0a60cfccebe2d460a2b738fc7fdb))
* initial jsbeeb MCP server ([2550c91](https://github.com/mattgodbolt/jsbeeb-mcp/commit/2550c91f9aba3c9a97b2279bcd00b767ae33817b))
