#!/usr/bin/env node
const directEntry=process.argv[1]===import.meta.filename&&!process.execArgv.some(value=>/^(?:-e|-p|--eval|--print)(?:=|$)/u.test(value));
const inlineTestEntry=directEntry&&Boolean(process.env.NODE_TEST_CONTEXT)&&process.argv.length===2;
// 公民服务独立拥有声明、资源、现场及Worker编译；其它流程只调用公开接口。
export const contract=Object.freeze({
  "schema": 1,
  "product_id": "citizenserve",
  "platforms": {
    "cloudflare": {
      "files": [
        "worker/index.js",
        "worker/index_bg.wasm"
      ],
      "completion": "compile-only",
      "work_claim": "product"
    }
  },
  "tatachat": {
    "protocol": {
      "source": "https://github.com/tuyutata/tatachatsdk.git",
      "commit": "b0485cf0a2c0922791741a748fdec0a49003089f",
      "files": [
        {
          "name": "message.proto",
          "source_path": "lib/protocol/message.proto",
          "sha256": "f51d9fc81a1128d6fb522af4ba8b785154e94c31b09147cfba274916097f1dd3",
          "bytes": 778
        },
        {
          "name": "attachment.proto",
          "source_path": "lib/protocol/attachment.proto",
          "sha256": "e70307165a76a053408a9a7a47fdce5902dd1282e0547dbdd1af732aa48d39b2",
          "bytes": 558
        },
        {
          "name": "chat_frame.proto",
          "source_path": "lib/protocol/chat_frame.proto",
          "sha256": "0efeeac8d579a250e44cae3a34f07989c1127c3d834d7cf372129671a04a478d",
          "bytes": 2534
        }
      ]
    },
    "protoc": {
      "id": "protoc",
      "version": "35.0",
      "source": "https://github.com/protocolbuffers/protobuf/releases/tag/v35.0",
      "archives": {
        "darwin-arm64": {
          "url": "https://github.com/protocolbuffers/protobuf/releases/download/v35.0/protoc-35.0-osx-aarch_64.zip",
          "sha256": "45444963204757fd3e2fbe304bc1fdadfb488d8556ff099c4cc06575eab88976"
        },
        "linux-x64": {
          "url": "https://github.com/protocolbuffers/protobuf/releases/download/v35.0/protoc-35.0-linux-x86_64.zip",
          "sha256": "a45cda0989c17dd950db55f6fbe1e5814c50fda08e87aa422980ac1f89dddbbc"
        }
      }
    }
  },
  "resource_entry": "scripts/build.mjs",
  "resources": {
    "schema": 1,
    "bootstrap": {
      "node_version": "25.2.1",
      "platforms": {
        "linux-x64": {
          "url": "https://nodejs.org/dist/v25.2.1/node-v25.2.1-linux-x64.tar.gz",
          "sha256": "2094ecdc844ea11e9777cac42672b0d89cd63d27204193a587dc5a2d276bb940",
          "root": "node-v25.2.1-linux-x64",
          "executable": "bin/node",
          "kind": "tar-gzip"
        },
        "darwin-arm64": {
          "url": "https://nodejs.org/dist/v25.2.1/node-v25.2.1-darwin-arm64.tar.gz",
          "sha256": "be87e21bd235a451fad02c89e5bf7cb17e206e4cd89dd5664f20d19e7dfde6f9",
          "root": "node-v25.2.1-darwin-arm64",
          "executable": "bin/node",
          "kind": "tar-gzip",
          "executable_sha256": "fe5f8e722c24b33f748ca94065b67fb6fea7ae25e054da347d95fa24d0d4b8da"
        }
      }
    },
    "tools": {
      "git": {
        "version": "2.54.0",
        "platforms": {
          "darwin-arm64": {
            "url": "https://www.kernel.org/pub/software/scm/git/git-2.54.0.tar.xz",
            "sha256": "f689162364c10de79ef89aa8dbf48731eb057e34edbbd20aca510ce0154681a3",
            "root": "git-2.54.0",
            "executable": "bin/git",
            "kind": "native-source"
          },
          "linux-x64": {
            "url": "https://www.kernel.org/pub/software/scm/git/git-2.54.0.tar.xz",
            "sha256": "f689162364c10de79ef89aa8dbf48731eb057e34edbbd20aca510ce0154681a3",
            "root": "git-2.54.0",
            "executable": "bin/git",
            "kind": "native-source"
          }
        }
      },
      "python": {
        "version": "3.14.3",
        "platforms": {
          "darwin-arm64": {
            "url": "https://www.python.org/ftp/python/3.14.3/Python-3.14.3.tar.xz",
            "sha256": "a97d5549e9ad81fe17159ed02c68774ad5d266c72f8d9a0b5a9c371fe85d902b",
            "root": "Python-3.14.3",
            "executable": "bin/python3.14",
            "kind": "native-source"
          },
          "linux-x64": {
            "url": "https://www.python.org/ftp/python/3.14.3/Python-3.14.3.tar.xz",
            "sha256": "a97d5549e9ad81fe17159ed02c68774ad5d266c72f8d9a0b5a9c371fe85d902b",
            "root": "Python-3.14.3",
            "executable": "bin/python3.14",
            "kind": "native-source"
          }
        },
        "dependencies": [
          {
            "name": "xz",
            "version": "5.8.2",
            "url": "https://github.com/tukaani-project/xz/releases/download/v5.8.2/xz-5.8.2.tar.xz",
            "sha256": "890966ec3f5d5cc151077879e157c0593500a522f413ac50ba26d22a9a145214",
            "root": "xz-5.8.2"
          }
        ]
      },
      "bash": {
        "version": "5.3.20",
        "platforms": {
          "darwin-arm64": {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3.tar.gz",
            "sha256": "0d5cd86965f869a26cf64f4b71be7b96f90a3ba8b3d74e27e8e9d9d5550f31ba",
            "root": "bash-5.3",
            "executable": "bin/bash",
            "kind": "native-source",
            "mirrors": [
              "https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3.tar.gz",
              "https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3.tar.gz"
            ]
          },
          "linux-x64": {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3.tar.gz",
            "sha256": "0d5cd86965f869a26cf64f4b71be7b96f90a3ba8b3d74e27e8e9d9d5550f31ba",
            "root": "bash-5.3",
            "executable": "bin/bash",
            "kind": "native-source",
            "mirrors": [
              "https://mirrors.ocf.berkeley.edu/gnu/bash/bash-5.3.tar.gz",
              "https://mirror.csclub.uwaterloo.ca/gnu/bash/bash-5.3.tar.gz"
            ]
          }
        },
        "patches": [
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-001",
            "sha256": "1f608434364af86b9b45c8b0ea3fb3b165fb830d27697e6cdfc7ac17dee3287f"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-002",
            "sha256": "e385548a00130765ec7938a56fbdca52447ab41fabc95a25f19ade527e282001"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-003",
            "sha256": "f245d9c7dc3f5a20d84b53d249334747940936f09dc97e1dcb89fc3ab37d60ed"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-004",
            "sha256": "9591d245045529f32f0812f94180b9d9ce9023f5a765c039b852e5dfc99747d0"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-005",
            "sha256": "cca1ef52dbbf433bc98e33269b64b2c814028efe2538be1e2c9a377da90bc99d"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-006",
            "sha256": "29119addefed8eff91ae37fd51822c31780ee30d4a28376e96002706c995ff10"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-007",
            "sha256": "c0976bbfffa1453c7cfdd62058f206a318568ff2d690f5d4fa048793fa3eb299"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-008",
            "sha256": "097cd723cbfb8907674ac32214063a3fd85282657ec5b4e544d2c0f719653fb4"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-009",
            "sha256": "eee30fe78a4b0cb2fe20e010e00308899cfc613e0774ebb3c8557a1552f24f8c"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-010",
            "sha256": "cf76f1cce2ea300c18bff9f002d21f280cc931acd17c28518110b93fe6e72569"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-011",
            "sha256": "0298df8f5ea2a31d3be43ed7d269c5b3c7c342dd5b570bea7f64d66dcbbe7531"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-012",
            "sha256": "d71379b39bebaedaf123414414e77fb458a0a43b9ad3116594c6df7ca6754573"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-013",
            "sha256": "042f9cda967e24bf4211944697441e93d06ff42b4b998629a98a1b249279f200"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-014",
            "sha256": "bd4360b401d38507e358783dcad8536a99c6789f0d3a5bd0cfb8c4a34144696c"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-015",
            "sha256": "55b79ceee2fc27f6767eed697e939a7eb2fe2a28c01556bd75f18d581014f46e"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-016",
            "sha256": "9ea29b266b7d24cb34d0ff3f1c4631e4d527bfe2d1ef15d17cdb924bf31ef767"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-017",
            "sha256": "443b927b45c1558ca72052410f8b8f6e5152b617ed707061a2781d4375b0d1c3"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-018",
            "sha256": "ae715d76c50341d7d7095e9a8d2eeed1ca9546152c2ac7289206f90cf30ac697"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-019",
            "sha256": "a25c581e4d0057dea3833918438a930e2e86ee4c6dc17fe15267b7f04cbc4e3d"
          },
          {
            "url": "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-020",
            "sha256": "df217ed3a9122aa2286d9b67bbe348661b6a9db262b580c29150dae55d532896"
          }
        ]
      },
      "perl": {
        "version": "5.42.3",
        "platforms": {
          "darwin-arm64": {
            "url": "https://www.cpan.org/src/5.0/perl-5.42.3.tar.xz",
            "sha256": "c9387e1473a1866935cb047ece7c2e0a80767a3acdecb79d4a375f8a95970ddc",
            "root": "perl-5.42.3",
            "executable": "bin/perl",
            "kind": "native-source"
          },
          "linux-x64": {
            "url": "https://www.cpan.org/src/5.0/perl-5.42.3.tar.xz",
            "sha256": "c9387e1473a1866935cb047ece7c2e0a80767a3acdecb79d4a375f8a95970ddc",
            "root": "perl-5.42.3",
            "executable": "bin/perl",
            "kind": "native-source"
          }
        }
      },
      "openssl": {
        "version": "3.6.3",
        "platforms": {
          "darwin-arm64": {
            "url": "https://github.com/openssl/openssl/releases/download/openssl-3.6.3/openssl-3.6.3.tar.gz",
            "sha256": "243a86649cf6f23eeb6a2ff2456e09e5d77dd9018a54d3d96b0c6bdd6ba6c7f1",
            "root": "openssl-3.6.3",
            "executable": "bin/openssl",
            "kind": "native-source"
          },
          "linux-x64": {
            "url": "https://github.com/openssl/openssl/releases/download/openssl-3.6.3/openssl-3.6.3.tar.gz",
            "sha256": "243a86649cf6f23eeb6a2ff2456e09e5d77dd9018a54d3d96b0c6bdd6ba6c7f1",
            "root": "openssl-3.6.3",
            "executable": "bin/openssl",
            "kind": "native-source"
          }
        }
      },
      "worker-build": {
        "version": null,
        "platforms": {
          "darwin-arm64": {
            "url": "https://static.crates.io/crates/worker-build/worker-build-0.8.5.crate",
            "sha256": "06c489585a93ce94210df365a879c8a5ceab27f4d2c380484c26642469e78a36",
            "root": "worker-build-0.8.5",
            "executable": "bin/worker-build",
            "kind": "cargo-source"
          },
          "linux-x64": null
        }
      },
      "rust": {
        "version": "1.97.1",
        "platforms": {
          "darwin-arm64": {
            "url": "https://static.rust-lang.org/dist/2026-07-16/rust-1.97.1-aarch64-apple-darwin.tar.xz",
            "sha256": "c9748cc86107734a2a024069908a895de7caa2d37062fb641eef9f756938ace2",
            "root": "rust-1.97.1-aarch64-apple-darwin",
            "executable": "bin/rustc",
            "kind": "rust"
          },
          "linux-x64": {
            "url": "https://static.rust-lang.org/dist/2026-07-16/rustc-1.97.1-x86_64-unknown-linux-gnu.tar.gz",
            "sha256": "1c441e430c1cca49dff54a8d59c41038bf6f79f7b8756596cb2f36511a015eba",
            "root": "rustc-1.97.1-x86_64-unknown-linux-gnu",
            "executable": "bin/rustc",
            "kind": "rust-gzip"
          }
        },
        "std": {
          "target": "wasm32-unknown-unknown",
          "platforms": {
            "darwin-arm64": {
              "url": "https://static.rust-lang.org/dist/2026-07-16/rust-std-1.97.1-wasm32-unknown-unknown.tar.xz",
              "sha256": "fa0edb6e9f34faae5735554d62d50875eded839dc707d0f1c01467a918d8453b",
              "root": "rust-std-1.97.1-wasm32-unknown-unknown",
              "executable": "",
              "kind": "rust"
            },
            "linux-x64": {
              "url": "https://static.rust-lang.org/dist/2026-07-16/rust-std-1.97.1-wasm32-unknown-unknown.tar.gz",
              "sha256": "13902d5573eeea50701d75acc774b6df2dfb4942ec88cdbe40bb07e448c307ea",
              "root": "rust-std-1.97.1-wasm32-unknown-unknown",
              "executable": "",
              "kind": "rust-gzip"
            }
          }
        },
        "components": [
          {
            "url": "https://static.rust-lang.org/dist/2026-07-16/cargo-1.97.1-x86_64-unknown-linux-gnu.tar.gz",
            "sha256": "90cbeb8adfe8ca0fcbe01a18bd9b99d3e5e98fd29c003032828ebf3ffba0e4ed",
            "root": "cargo-1.97.1-x86_64-unknown-linux-gnu",
            "executable": "",
            "kind": "rust-gzip"
          },
          {
            "url": "https://static.rust-lang.org/dist/2026-07-16/rustfmt-1.97.1-x86_64-unknown-linux-gnu.tar.gz",
            "sha256": "810f7dcfe64bdaf3e10cbe942274f76cdab2ffca813bfafc75e9d86a6809f039",
            "root": "rustfmt-1.97.1-x86_64-unknown-linux-gnu",
            "executable": "",
            "kind": "rust-gzip"
          },
          {
            "url": "https://static.rust-lang.org/dist/2026-07-16/clippy-1.97.1-x86_64-unknown-linux-gnu.tar.gz",
            "sha256": "66f93a616bc84939e116e960599b3bc122be7b51f6562bad71011a64a9293dc3",
            "root": "clippy-1.97.1-x86_64-unknown-linux-gnu",
            "executable": "",
            "kind": "rust-gzip"
          },
          {
            "url": "https://static.rust-lang.org/dist/2026-07-16/rust-std-1.97.1-x86_64-unknown-linux-gnu.tar.gz",
            "sha256": "45b927ecf776b9645ca2ed5b287fc6814824a073c30c7c5d5c0ad4425295ecee",
            "root": "rust-std-1.97.1-x86_64-unknown-linux-gnu",
            "executable": "",
            "kind": "rust-gzip"
          }
        ]
      },
      "protoc": {
        "version": null,
        "platforms": {
          "darwin-arm64": {
            "url": "https://github.com/protocolbuffers/protobuf/releases/download/v35.0/protoc-35.0-osx-aarch_64.zip",
            "sha256": "45444963204757fd3e2fbe304bc1fdadfb488d8556ff099c4cc06575eab88976",
            "root": ".",
            "executable": "bin/protoc",
            "kind": "extract"
          },
          "linux-x64": null
        }
      },
      "actionlint": {
        "version": "1.7.12",
        "platforms": {
          "darwin-arm64": {
            "url": "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_darwin_arm64.tar.gz",
            "sha256": "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
            "root": ".",
            "executable": "actionlint",
            "kind": "extract"
          },
          "linux-x64": {
            "url": "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
            "sha256": "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
            "root": ".",
            "executable": "actionlint",
            "kind": "extract"
          }
        }
      },
      "wasm-bindgen": {
        "version": null,
        "platforms": {
          "darwin-arm64": {
            "url": "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.127/wasm-bindgen-0.2.127-aarch64-apple-darwin.tar.gz",
            "sha256": "cd93e691eb5953ace5d8ffce52a20b024077a3dac3e2215b8224136b0efb7585",
            "root": "wasm-bindgen-0.2.127-aarch64-apple-darwin",
            "executable": "wasm-bindgen",
            "kind": "extract"
          },
          "linux-x64": null
        }
      },
      "wasm-opt": {
        "version": null,
        "platforms": {
          "darwin-arm64": {
            "url": "https://github.com/WebAssembly/binaryen/releases/download/version_130/binaryen-version_130-arm64-macos.tar.gz",
            "sha256": "79d3ab9f417d9e215f15f598f523d001a7d9ac1e59367e5c869fbdabd1cba72e",
            "root": "binaryen-version_130",
            "executable": "bin/wasm-opt",
            "kind": "extract"
          },
          "linux-x64": null
        }
      }
    },
    "preparation": {
      "linux-x64": {
        "busybox": {
          "version": "1.36.1-6ubuntu3.1",
          "url": "https://security.ubuntu.com/ubuntu/pool/main/b/busybox/busybox-static_1.36.1-6ubuntu3.1_amd64.deb",
          "sha256": "944b2728f53ceb3916cec2c962873c9951e612408099601751db2a0a5d81e0ed",
          "root": ".",
          "executable": "usr/bin/busybox",
          "kind": "deb"
        },
        "make": {
          "version": "4.3-4.1build2",
          "url": "https://archive.ubuntu.com/ubuntu/pool/main/m/make-dfsg/make_4.3-4.1build2_amd64.deb",
          "sha256": "1fe6a815b56c7b6e9ce4086a363f09444bbd0a0d30e230c453d0b78e44b57a99",
          "root": ".",
          "executable": "usr/bin/make",
          "kind": "deb"
        },
        "zig": {
          "version": "0.16.0",
          "url": "https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz",
          "sha256": "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00",
          "root": "zig-x86_64-linux-0.16.0",
          "executable": "zig",
          "kind": "tar-xz"
        },
        "sqlite": {
          "version": "3.53.4",
          "url": "https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip",
          "integrity": "sha3-256:628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e",
          "root": "sqlite-amalgamation-3530400",
          "kind": "zip"
        },
        "zlib": {
          "version": "1.3.2",
          "url": "https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz",
          "sha256": "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16",
          "root": "zlib-1.3.2",
          "executable": "lib/libz.a",
          "kind": "tar-gzip"
        }
      }
    },
    "worker_build_lock_sha256": "cad1fc9d44dbbf49063145f18e11abd78f29ad23b78c0aaf01edd71e50e4e5a2",
    "worker_build_packages": [
      {
        "name": "adler2",
        "version": "2.0.1",
        "sha256": "320119579fcad9c21884f5c4861d16174d0e06250625266f50fe6898340abefa"
      },
      {
        "name": "aes",
        "version": "0.8.4",
        "sha256": "b169f7a6d4742236a0a00c541b845991d0ac43e546831af1249753ab4c3aa3a0"
      },
      {
        "name": "aho-corasick",
        "version": "1.1.4",
        "sha256": "ddd31a130427c27518df266943a5308ed92d4b226cc639f5a8f1002816174301"
      },
      {
        "name": "anstream",
        "version": "1.0.0",
        "sha256": "824a212faf96e9acacdbd09febd34438f8f711fb84e09a8916013cd7815ca28d"
      },
      {
        "name": "anstyle",
        "version": "1.0.14",
        "sha256": "940b3a0ca603d1eade50a4846a2afffd5ef57a9feac2c0e2ec2e14f9ead76000"
      },
      {
        "name": "anstyle-parse",
        "version": "1.0.0",
        "sha256": "52ce7f38b242319f7cabaa6813055467063ecdc9d355bbb4ce0c68908cd8130e"
      },
      {
        "name": "anstyle-query",
        "version": "1.1.5",
        "sha256": "40c48f72fd53cd289104fc64099abca73db4166ad86ea0b4341abe65af83dadc"
      },
      {
        "name": "anstyle-wincon",
        "version": "3.0.11",
        "sha256": "291e6a250ff86cd4a820112fb8898808a366d8f9f58ce16d1f538353ad55747d"
      },
      {
        "name": "anyhow",
        "version": "1.0.102",
        "sha256": "7f202df86484c868dbad7eaa557ef785d5c66295e41b460ef922eca0723b842c"
      },
      {
        "name": "arbitrary",
        "version": "1.4.2",
        "sha256": "c3d036a3c4ab069c7b410a2ce876bd74808d2d0888a82667669f8e783a898bf1"
      },
      {
        "name": "autocfg",
        "version": "1.5.1",
        "sha256": "f2032f911046de80f0a198e0901378627c33f59ea0ac00e363d481118bd70a53"
      },
      {
        "name": "base64",
        "version": "0.22.1",
        "sha256": "72b3254f16251a8381aa12e40e3c4d2f0199f8c6508fbecb9d91f575e0fbb8c6"
      },
      {
        "name": "base64ct",
        "version": "1.8.3",
        "sha256": "2af50177e190e07a26ab74f8b1efbfe2ef87da2116221318cb1c2e82baf7de06"
      },
      {
        "name": "binary-install",
        "version": "0.4.1",
        "sha256": "5252e41a4ed7657f79827123f232443077984ec55c540adf48e8fe67b6ec0763"
      },
      {
        "name": "bitflags",
        "version": "2.13.0",
        "sha256": "b4388bee8683e3d04af747c73422af53102d2bd24d9eadb6cbc100baef4b43f8"
      },
      {
        "name": "block-buffer",
        "version": "0.10.4",
        "sha256": "3078c7629b62d3f0439517fa394996acacc5cbc91c5a20d8c658e77abd503a71"
      },
      {
        "name": "bumpalo",
        "version": "3.20.3",
        "sha256": "72f5acc6cb2ba439de613abc23857ec3d78374d8ed5ac84e9d11336e87da8649"
      },
      {
        "name": "byteorder",
        "version": "1.5.0",
        "sha256": "1fd0f2584146f6f2ef48085050886acf353beff7305ebd1ae69500e27c67f64b"
      },
      {
        "name": "bytes",
        "version": "1.11.1",
        "sha256": "1e748733b7cbc798e1434b6ac524f0c1ff2ab456fe201501e6497c8417a4fc33"
      },
      {
        "name": "bzip2",
        "version": "0.5.2",
        "sha256": "49ecfb22d906f800d4fe833b6282cf4dc1c298f5057ca0b5445e5c209735ca47"
      },
      {
        "name": "bzip2-sys",
        "version": "0.1.13+1.0.8",
        "sha256": "225bff33b2141874fe80d71e07d6eec4f85c5c216453dd96388240f96e1acc14"
      },
      {
        "name": "camino",
        "version": "1.2.2",
        "sha256": "e629a66d692cb9ff1a1c664e41771b3dcaf961985a9774c0eb0bd1b51cf60a48"
      },
      {
        "name": "cargo-platform",
        "version": "0.2.0",
        "sha256": "84982c6c0ae343635a3a4ee6dedef965513735c8b183caa7289fa6e27399ebd4"
      },
      {
        "name": "cargo-util-schemas",
        "version": "0.2.0",
        "sha256": "e63d2780ac94487eb9f1fea7b0d56300abc9eb488800854ca217f102f5caccca"
      },
      {
        "name": "cargo_metadata",
        "version": "0.20.0",
        "sha256": "4f7835cfc6135093070e95eb2b53e5d9b5c403dc3a6be6040ee026270aa82502"
      },
      {
        "name": "cc",
        "version": "1.2.64",
        "sha256": "dad887fd958be91b5098c0248def011f4523ab786cd411be668777e55063501f"
      },
      {
        "name": "cfg-if",
        "version": "1.0.4",
        "sha256": "9330f8b2ff13f34540b44e946ef35111825727b38d33286ef986142615121801"
      },
      {
        "name": "cipher",
        "version": "0.4.4",
        "sha256": "773f3b9af64447d2ce9850330c473515014aa235e6a783b02db81ff39e4a3dad"
      },
      {
        "name": "clap",
        "version": "4.6.1",
        "sha256": "1ddb117e43bbf7dacf0a4190fef4d345b9bad68dfc649cb349e7d17d28428e51"
      },
      {
        "name": "clap_builder",
        "version": "4.6.0",
        "sha256": "714a53001bf66416adb0e2ef5ac857140e7dc3a0c48fb28b2f10762fc4b5069f"
      },
      {
        "name": "clap_derive",
        "version": "4.6.1",
        "sha256": "f2ce8604710f6733aa641a2b3731eaa1e8b3d9973d5e3565da11800813f997a9"
      },
      {
        "name": "clap_lex",
        "version": "1.1.0",
        "sha256": "c8d4a3bb8b1e0c1050499d1815f5ab16d04f0959b233085fb31653fbfc9d98f9"
      },
      {
        "name": "colorchoice",
        "version": "1.0.5",
        "sha256": "1d07550c9036bf2ae0c684c4297d503f838287c83c53686d05370d0e139ae570"
      },
      {
        "name": "console",
        "version": "0.16.3",
        "sha256": "d64e8af5551369d19cf50138de61f1c42074ab970f74e99be916646777f8fc87"
      },
      {
        "name": "constant_time_eq",
        "version": "0.3.1",
        "sha256": "7c74b8349d32d297c9134b8c88677813a227df8f779daa29bfc29c183fe3dca6"
      },
      {
        "name": "convert_case",
        "version": "0.6.0",
        "sha256": "ec182b0ca2f35d8fc196cf3404988fd8b8c739a4d270ff118a398feb0cbec1ca"
      },
      {
        "name": "cookie",
        "version": "0.18.1",
        "sha256": "4ddef33a339a91ea89fb53151bd0a4689cfce27055c291dfa69945475d22c747"
      },
      {
        "name": "cookie_store",
        "version": "0.22.1",
        "sha256": "15b2c103cf610ec6cae3da84a766285b42fd16aad564758459e6ecf128c75206"
      },
      {
        "name": "core-foundation",
        "version": "0.10.1",
        "sha256": "b2a6cd9ae233e7f62ba4e9353e81a88df7fc8a5987b8d445b4d90c879bd156f6"
      },
      {
        "name": "core-foundation-sys",
        "version": "0.8.7",
        "sha256": "773648b94d0e5d620f64f280777445740e61fe701025087ec8b57f45c791888b"
      },
      {
        "name": "cpufeatures",
        "version": "0.2.17",
        "sha256": "59ed5838eebb26a2bb2e58f6d5b5316989ae9d08bab10e0e6d103e656d1b0280"
      },
      {
        "name": "crc",
        "version": "3.4.0",
        "sha256": "5eb8a2a1cd12ab0d987a5d5e825195d372001a4094a0376319d5a0ad71c1ba0d"
      },
      {
        "name": "crc-catalog",
        "version": "2.5.0",
        "sha256": "217698eaf96b4a3f0bc4f3662aaa55bdf913cd54d7204591faa790070c6d0853"
      },
      {
        "name": "crc32fast",
        "version": "1.5.0",
        "sha256": "9481c1c90cbf2ac953f07c8d4a58aa3945c425b7185c9154d67a65e4230da511"
      },
      {
        "name": "crossbeam-deque",
        "version": "0.8.6",
        "sha256": "9dd111b7b7f7d55b72c0a6ae361660ee5853c9af73f70c3c2ef6858b950e2e51"
      },
      {
        "name": "crossbeam-epoch",
        "version": "0.9.18",
        "sha256": "5b82ac4a3c2ca9c3460964f020e1402edd5753411d7737aa39c3714ad1b5420e"
      },
      {
        "name": "crossbeam-utils",
        "version": "0.8.21",
        "sha256": "d0a5c400df2834b80a4c3327b3aad3a4c4cd4de0629063962b03235697506a28"
      },
      {
        "name": "crypto-common",
        "version": "0.1.7",
        "sha256": "78c8292055d1c1df0cce5d180393dc8cce0abec0a7102adb6c7b1eef6016d60a"
      },
      {
        "name": "deflate64",
        "version": "0.1.12",
        "sha256": "ac6b926516df9c60bfa16e107b21086399f8285a44ca9711344b9e553c5146e2"
      },
      {
        "name": "der",
        "version": "0.8.0",
        "sha256": "71fd89660b2dc699704064e59e9dba0147b903e85319429e131620d022be411b"
      },
      {
        "name": "deranged",
        "version": "0.5.8",
        "sha256": "7cd812cc2bc1d69d4764bd80df88b4317eaef9e773c75226407d9bc0876b211c"
      },
      {
        "name": "derive_arbitrary",
        "version": "1.4.2",
        "sha256": "1e567bd82dcff979e4b03460c307b3cdc9e96fde3d73bed1496d2bc75d9dd62a"
      },
      {
        "name": "digest",
        "version": "0.10.7",
        "sha256": "9ed9a281f7bc9b7576e61468ba615a66a5c8cfdff42420a70aa82701a3b1e292"
      },
      {
        "name": "dirs-next",
        "version": "2.0.0",
        "sha256": "b98cf8ebf19c3d1b223e151f99a4f9f0690dca41414773390fc824184ac833e1"
      },
      {
        "name": "dirs-sys-next",
        "version": "0.1.2",
        "sha256": "4ebda144c4fe02d1f7ea1a7d9641b6fc6b580adcfa024ae48797ecdeb6825b4d"
      },
      {
        "name": "displaydoc",
        "version": "0.2.6",
        "sha256": "1ac70aa55017e108007fbaf5aa0f54b021c98f92ff8af59d42eda9da96e3dd4f"
      },
      {
        "name": "document-features",
        "version": "0.2.12",
        "sha256": "d4b8a88685455ed29a21542a33abd9cb6510b6b129abadabdcef0f4c55bc8f61"
      },
      {
        "name": "either",
        "version": "1.16.0",
        "sha256": "91622ff5e7162018101f2fea40d6ebf4a78bbe5a49736a2020649edf9693679e"
      },
      {
        "name": "encode_unicode",
        "version": "1.0.0",
        "sha256": "34aa73646ffb006b8f5147f3dc182bd4bcb190227ce861fc4a4844bf8e3cb2c0"
      },
      {
        "name": "env_filter",
        "version": "1.0.1",
        "sha256": "32e90c2accc4b07a8456ea0debdc2e7587bdd890680d71173a15d4ae604f6eef"
      },
      {
        "name": "env_logger",
        "version": "0.11.10",
        "sha256": "0621c04f2196ac3f488dd583365b9c09be011a4ab8b9f37248ffcc8f6198b56a"
      },
      {
        "name": "equivalent",
        "version": "1.0.2",
        "sha256": "877a4ace8713b0bcf2a4e7eec82529c029f1d0619886d18145fea96c3ffe5c0f"
      },
      {
        "name": "erased-serde",
        "version": "0.4.10",
        "sha256": "d2add8a07dd6a8d93ff627029c51de145e12686fbc36ecb298ac22e74cf02dec"
      },
      {
        "name": "errno",
        "version": "0.3.14",
        "sha256": "39cab71617ae0d63f51a36d69f866391735b51691dbda63cf6f96d042b63efeb"
      },
      {
        "name": "fallible-iterator",
        "version": "0.3.0",
        "sha256": "2acce4a10f12dc2fb14a218589d4f1f62ef011b2d0cc4b3cb1bba8e94da14649"
      },
      {
        "name": "fastrand",
        "version": "2.4.1",
        "sha256": "9f1f227452a390804cdb637b74a86990f2a7d7ba4b7d5693aac9b4dd6defd8d6"
      },
      {
        "name": "filetime",
        "version": "0.2.29",
        "sha256": "5c287a33c7f0a620c38e641e7f60827713987b3c0f26e8ddc9462cc69cf75759"
      },
      {
        "name": "find-msvc-tools",
        "version": "0.1.9",
        "sha256": "5baebc0774151f905a1a2cc41989300b1e6fbb29aff0ceffa1064fdd3088d582"
      },
      {
        "name": "flate2",
        "version": "1.1.9",
        "sha256": "843fba2746e448b37e26a819579957415c8cef339bf08564fe8b7ddbd959573c"
      },
      {
        "name": "foldhash",
        "version": "0.1.5",
        "sha256": "d9c4f5dac5e15c24eb999c26181a6ca40b39fe946cbe4c263c7209467bc83af2"
      },
      {
        "name": "foldhash",
        "version": "0.2.0",
        "sha256": "77ce24cb58228fbb8aa041425bb1050850ac19177686ea6e0f41a70416f56fdb"
      },
      {
        "name": "foreign-types",
        "version": "0.3.2",
        "sha256": "f6f339eb8adc052cd2ca78910fda869aefa38d22d5cb648e6485e4d3fc06f3b1"
      },
      {
        "name": "foreign-types-shared",
        "version": "0.1.1",
        "sha256": "00b0228411908ca8685dba7fc2cdd70ec9990a6e753e89b6ac91a84c40fbaf4b"
      },
      {
        "name": "form_urlencoded",
        "version": "1.2.2",
        "sha256": "cb4cb245038516f5f85277875cdaa4f7d2c9a0fa0468de06ed190163b1581fcf"
      },
      {
        "name": "fs4",
        "version": "0.6.6",
        "sha256": "2eeb4ed9e12f43b7fa0baae3f9cdda28352770132ef2e09a23760c29cae8bd47"
      },
      {
        "name": "futures-core",
        "version": "0.3.32",
        "sha256": "7e3450815272ef58cec6d564423f6e755e25379b217b0bc688e295ba24df6b1d"
      },
      {
        "name": "futures-task",
        "version": "0.3.32",
        "sha256": "037711b3d59c33004d3856fbdc83b99d4ff37a24768fa1be9ce3538a1cde4393"
      },
      {
        "name": "futures-util",
        "version": "0.3.32",
        "sha256": "389ca41296e6190b48053de0321d02a77f32f8a5d2461dd38762c0593805c6d6"
      },
      {
        "name": "generic-array",
        "version": "0.14.7",
        "sha256": "85649ca51fd72272d7821adaf274ad91c288277713d9c18820d8499a7ff69e9a"
      },
      {
        "name": "getrandom",
        "version": "0.2.17",
        "sha256": "ff2abc00be7fca6ebc474524697ae276ad847ad0a6b3faa4bcb027e9a4614ad0"
      },
      {
        "name": "getrandom",
        "version": "0.3.4",
        "sha256": "899def5c37c4fd7b2664648c28120ecec138e4d395b459e5ca34f9cce2dd77fd"
      },
      {
        "name": "getrandom",
        "version": "0.4.2",
        "sha256": "0de51e6874e94e7bf76d726fc5d13ba782deca734ff60d5bb2fb2607c7406555"
      },
      {
        "name": "gimli",
        "version": "0.32.3",
        "sha256": "e629b9b98ef3dd8afe6ca2bd0f89306cec16d43d907889945bc5d6687f2f13c7"
      },
      {
        "name": "glob",
        "version": "0.3.3",
        "sha256": "0cc23270f6e1808e30a928bdc84dea0b9b4136a8bc82338574f23baf47bbd280"
      },
      {
        "name": "hashbrown",
        "version": "0.15.5",
        "sha256": "9229cfe53dfd69f0609a49f65461bd93001ea1ef889cd5529dd176593f5338a1"
      },
      {
        "name": "hashbrown",
        "version": "0.16.1",
        "sha256": "841d1cc9bed7f9236f321df977030373f4a4163ae1a7dbfe1a51a2c1a51d9100"
      },
      {
        "name": "hashbrown",
        "version": "0.17.1",
        "sha256": "ed5909b6e89a2db4456e54cd5f673791d7eca6732202bbf2a9cc504fe2f9b84a"
      },
      {
        "name": "heck",
        "version": "0.5.0",
        "sha256": "2304e00983f87ffb38b55b444b5e3b60a884b5d30c0fca7d82fe33449bbe55ea"
      },
      {
        "name": "hex",
        "version": "0.4.3",
        "sha256": "7f24254aa9a54b5c858eaee2f5bccdb46aaf0e486a595ed5fd8f86ba55232a70"
      },
      {
        "name": "hmac",
        "version": "0.12.1",
        "sha256": "6c49c37c09c17a53d937dfbb742eb3a961d65a994e6bcdcf37e7399d0cc8ab5e"
      },
      {
        "name": "http",
        "version": "1.4.2",
        "sha256": "6970f50e31d6fc17d3fa27329444bfa74e196cf62e95052a3f6fee181dba6425"
      },
      {
        "name": "httparse",
        "version": "1.10.1",
        "sha256": "6dbf3de79e51f3d586ab4cb9d5c3e2c14aa28ed23d180cf89b4df0454a69cc87"
      },
      {
        "name": "icu_collections",
        "version": "2.2.0",
        "sha256": "2984d1cd16c883d7935b9e07e44071dca8d917fd52ecc02c04d5fa0b5a3f191c"
      },
      {
        "name": "icu_locale_core",
        "version": "2.2.0",
        "sha256": "92219b62b3e2b4d88ac5119f8904c10f8f61bf7e95b640d25ba3075e6cac2c29"
      },
      {
        "name": "icu_normalizer",
        "version": "2.2.0",
        "sha256": "c56e5ee99d6e3d33bd91c5d85458b6005a22140021cc324cea84dd0e72cff3b4"
      },
      {
        "name": "icu_normalizer_data",
        "version": "2.2.0",
        "sha256": "da3be0ae77ea334f4da67c12f149704f19f81d1adf7c51cf482943e84a2bad38"
      },
      {
        "name": "icu_properties",
        "version": "2.2.0",
        "sha256": "bee3b67d0ea5c2cca5003417989af8996f8604e34fb9ddf96208a033901e70de"
      },
      {
        "name": "icu_properties_data",
        "version": "2.2.0",
        "sha256": "8e2bbb201e0c04f7b4b3e14382af113e17ba4f63e2c9d2ee626b720cbce54a14"
      },
      {
        "name": "icu_provider",
        "version": "2.2.0",
        "sha256": "139c4cf31c8b5f33d7e199446eff9c1e02decfc2f0eec2c8d71f65befa45b421"
      },
      {
        "name": "id-arena",
        "version": "2.3.0",
        "sha256": "3d3067d79b975e8844ca9eb072e16b31c3c1c36928edf9c6789548c524d0d954"
      },
      {
        "name": "idna",
        "version": "1.1.0",
        "sha256": "3b0875f23caa03898994f6ddc501886a45c7d3d62d04d2d90788d47be1b1e4de"
      },
      {
        "name": "idna_adapter",
        "version": "1.2.2",
        "sha256": "cb68373c0d6620ef8105e855e7745e18b0d00d3bdb07fb532e434244cdb9a714"
      },
      {
        "name": "indexmap",
        "version": "2.14.0",
        "sha256": "d466e9454f08e4a911e14806c24e16fba1b4c121d1ea474396f396069cf949d9"
      },
      {
        "name": "inout",
        "version": "0.1.4",
        "sha256": "879f10e63c20629ecabbb64a8010319738c66a5cd0c29b02d63d272b03751d01"
      },
      {
        "name": "is_executable",
        "version": "0.1.2",
        "sha256": "302d553b8abc8187beb7d663e34c065ac4570b273bc9511a50e940e99409c577"
      },
      {
        "name": "is_terminal_polyfill",
        "version": "1.70.2",
        "sha256": "a6cb138bb79a146c1bd460005623e142ef0181e3d0219cb493e02f7d08a35695"
      },
      {
        "name": "itoa",
        "version": "1.0.18",
        "sha256": "8f42a60cbdf9a97f5d2305f08a87dc4e09308d1276d28c869c684d7777685682"
      },
      {
        "name": "jiff",
        "version": "0.2.28",
        "sha256": "4603d3033e49e2b0e31229fcab20a5d40089c607d975cd9c80551dc69eed9102"
      },
      {
        "name": "jiff-static",
        "version": "0.2.28",
        "sha256": "782d32378dddf207193ac91cefb848ad41abb58195c95168e1291227a0832b47"
      },
      {
        "name": "jobserver",
        "version": "0.1.34",
        "sha256": "9afb3de4395d6b3e67a780b6de64b51c978ecf11cb9a462c66be7d4ca9039d33"
      },
      {
        "name": "js-sys",
        "version": "0.3.102",
        "sha256": "03d04c30968dffe80775bd4d7fb676131cd04a1fb46d2686dbffbaec2d9dfd31"
      },
      {
        "name": "leb128",
        "version": "0.2.6",
        "sha256": "6cc46bac87ef8093eed6f272babb833b6443374399985ac8ed28471ee0918545"
      },
      {
        "name": "leb128fmt",
        "version": "0.1.0",
        "sha256": "09edd9e8b54e49e587e4f6295a7d29c3ea94d469cb40ab8ca70b288248a81db2"
      },
      {
        "name": "libc",
        "version": "0.2.186",
        "sha256": "68ab91017fe16c622486840e4c83c9a37afeff978bd239b5293d61ece587de66"
      },
      {
        "name": "libredox",
        "version": "0.1.17",
        "sha256": "f02ab6bace2054fb888a3c16f990117b579d14a3088e472d63c6011fa185c9d3"
      },
      {
        "name": "linux-raw-sys",
        "version": "0.4.15",
        "sha256": "d26c52dbd32dccf2d10cac7725f8eae5296885fb5703b261f7d0a0739ec807ab"
      },
      {
        "name": "linux-raw-sys",
        "version": "0.12.1",
        "sha256": "32a66949e030da00e8c7d4434b251670a91556f4144941d37452769c25d58a53"
      },
      {
        "name": "litemap",
        "version": "0.8.2",
        "sha256": "92daf443525c4cce67b150400bc2316076100ce0b3686209eb8cf3c31612e6f0"
      },
      {
        "name": "litrs",
        "version": "1.0.0",
        "sha256": "11d3d7f243d5c5a8b9bb5d6dd2b1602c0cb0b9db1621bafc7ed66e35ff9fe092"
      },
      {
        "name": "lock_api",
        "version": "0.4.14",
        "sha256": "224399e74b87b5f3557511d98dff8b14089b3dadafcab6bb93eab67d3aace965"
      },
      {
        "name": "log",
        "version": "0.4.32",
        "sha256": "953f07c43838f8e6f9758cab68bf5bed85465e7587ebe0b823f1bcd81978ad3a"
      },
      {
        "name": "lzma-rs",
        "version": "0.3.0",
        "sha256": "297e814c836ae64db86b36cf2a557ba54368d03f6afcd7d947c266692f71115e"
      },
      {
        "name": "lzma-sys",
        "version": "0.1.20",
        "sha256": "5fda04ab3764e6cde78b9974eec4f779acaba7c4e84b36eca3cf77c581b85d27"
      },
      {
        "name": "memchr",
        "version": "2.8.2",
        "sha256": "88904434abc2901f197fe8cc55f0445e7ded921dba5911dad2e2b39b48e663c4"
      },
      {
        "name": "miniz_oxide",
        "version": "0.8.9",
        "sha256": "1fa76a2c86f704bdb222d66965fb3d63269ce38518b83cb0575fca855ebb6316"
      },
      {
        "name": "native-tls",
        "version": "0.2.18",
        "sha256": "465500e14ea162429d264d44189adc38b199b62b1c21eea9f69e4b73cb03bbf2"
      },
      {
        "name": "num-conv",
        "version": "0.2.2",
        "sha256": "521739c6d2bac4aa25192232afe6841231376b2b26d4d9fae5ecf8ca5772e441"
      },
      {
        "name": "num-traits",
        "version": "0.2.19",
        "sha256": "071dfc062690e90b734c0b2273ce72ad0ffa95f0c74596bc250dcfd960262841"
      },
      {
        "name": "once_cell",
        "version": "1.21.4",
        "sha256": "9f7c3e4beb33f85d45ae3e3a1792185706c8e16d043238c593331cc7cd313b50"
      },
      {
        "name": "once_cell_polyfill",
        "version": "1.70.2",
        "sha256": "384b8ab6d37215f3c5301a95a4accb5d64aa607f1fcb26a11b5303878451b4fe"
      },
      {
        "name": "openssl",
        "version": "0.10.81",
        "sha256": "77823a27f0babb03091cb9ed9ef80af3b39dbc82f97e8fa530374b7dafd87a45"
      },
      {
        "name": "openssl-macros",
        "version": "0.1.1",
        "sha256": "a948666b637a0f465e8564c73e89d4dde00d72d4d473cc972f390fc3dcee7d9c"
      },
      {
        "name": "openssl-probe",
        "version": "0.2.1",
        "sha256": "7c87def4c32ab89d880effc9e097653c8da5d6ef28e6b539d313baaacfbafcbe"
      },
      {
        "name": "openssl-sys",
        "version": "0.9.117",
        "sha256": "b47e7e6bb2c38cd930d25a23b40fa52e068c10e85f3e03a7f5ba5aaca5713695"
      },
      {
        "name": "ordered-float",
        "version": "2.10.1",
        "sha256": "68f19d67e5a2795c94e73e0bb1cc1a7edeb2e28efd39e2e1c9b7a40c1108b11c"
      },
      {
        "name": "parking_lot",
        "version": "0.12.5",
        "sha256": "93857453250e3077bd71ff98b6a65ea6621a19bb0f559a85248955ac12c45a1a"
      },
      {
        "name": "parking_lot_core",
        "version": "0.9.12",
        "sha256": "2621685985a2ebf1c516881c026032ac7deafcda1a2c9b7850dc81e3dfcb64c1"
      },
      {
        "name": "path-clean",
        "version": "1.0.1",
        "sha256": "17359afc20d7ab31fdb42bb844c8b3bb1dabd7dcf7e68428492da7f16966fcef"
      },
      {
        "name": "pbkdf2",
        "version": "0.12.2",
        "sha256": "f8ed6a7761f76e3b9f92dfb0a60a6a6477c61024b775147ff0973a02653abaf2"
      },
      {
        "name": "pem-rfc7468",
        "version": "1.0.0",
        "sha256": "a6305423e0e7738146434843d1694d621cce767262b2a86910beab705e4493d9"
      },
      {
        "name": "percent-encoding",
        "version": "2.3.2",
        "sha256": "9b4f627cb1b25917193a259e49bdad08f671f8d9708acfd5fe0a8c1455d87220"
      },
      {
        "name": "pin-project-lite",
        "version": "0.2.17",
        "sha256": "a89322df9ebe1c1578d689c92318e070967d1042b512afbe49518723f4e6d5cd"
      },
      {
        "name": "pkg-config",
        "version": "0.3.33",
        "sha256": "19f132c84eca552bf34cab8ec81f1c1dcc229b811638f9d283dceabe58c5569e"
      },
      {
        "name": "portable-atomic",
        "version": "1.13.1",
        "sha256": "c33a9471896f1c69cecef8d20cbe2f7accd12527ce60845ff44c153bb2a21b49"
      },
      {
        "name": "portable-atomic-util",
        "version": "0.2.7",
        "sha256": "c2a106d1259c23fac8e543272398ae0e3c0b8d33c88ed73d0cc71b0f1d902618"
      },
      {
        "name": "potential_utf",
        "version": "0.1.5",
        "sha256": "0103b1cef7ec0cf76490e969665504990193874ea05c85ff9bab8b911d0a0564"
      },
      {
        "name": "powerfmt",
        "version": "0.2.0",
        "sha256": "439ee305def115ba05938db6eb1644ff94165c5ab5e9420d1c1bcedbba909391"
      },
      {
        "name": "prettyplease",
        "version": "0.2.37",
        "sha256": "479ca8adacdd7ce8f1fb39ce9ecccbfe93a3f1344b3d0d97f20bc0196208f62b"
      },
      {
        "name": "proc-macro2",
        "version": "1.0.106",
        "sha256": "8fd00f0bb2e90d81d1044c2b32617f68fcb9fa3bb7640c23e9c748e53fb30934"
      },
      {
        "name": "quote",
        "version": "1.0.45",
        "sha256": "41f2619966050689382d2b44f664f4bc593e129785a36d6ee376ddf37259b924"
      },
      {
        "name": "r-efi",
        "version": "5.3.0",
        "sha256": "69cdb34c158ceb288df11e18b4bd39de994f6657d83847bdffdbd7f346754b0f"
      },
      {
        "name": "r-efi",
        "version": "6.0.0",
        "sha256": "f8dcc9c7d52a811697d2151c701e0d08956f92b0e24136cf4cf27b57a6a0d9bf"
      },
      {
        "name": "rayon",
        "version": "1.12.0",
        "sha256": "fb39b166781f92d482534ef4b4b1b2568f42613b53e5b6c160e24cfbfa30926d"
      },
      {
        "name": "rayon-core",
        "version": "1.13.0",
        "sha256": "22e18b0f0062d30d4230b2e85ff77fdfe4326feb054b9783a3460d8435c8ab91"
      },
      {
        "name": "redox_syscall",
        "version": "0.5.18",
        "sha256": "ed2bf2547551a7053d6fdfafda3f938979645c44812fbfcda098faae3f1a362d"
      },
      {
        "name": "redox_users",
        "version": "0.4.6",
        "sha256": "ba009ff324d1fc1b900bd1fdb31564febe58a8ccc8a6fdbb93b543d33b13ca43"
      },
      {
        "name": "regex",
        "version": "1.12.4",
        "sha256": "f1292b7759ae1cb9ec195452d1390a074f0cd8541ab7a5a8c31cd6db45d4a6ba"
      },
      {
        "name": "regex-automata",
        "version": "0.4.14",
        "sha256": "6e1dd4122fc1595e8162618945476892eefca7b88c52820e74af6262213cae8f"
      },
      {
        "name": "regex-syntax",
        "version": "0.8.11",
        "sha256": "d6f6ff9a378485b298a5286656da665ba74413d36db0979633275d2e708145d4"
      },
      {
        "name": "ring",
        "version": "0.17.14",
        "sha256": "a4689e6c2294d81e88dc6261c768b63bc4fcdb852be6d1352498b114f61383b7"
      },
      {
        "name": "rustc-demangle",
        "version": "0.1.27",
        "sha256": "b50b8869d9fc858ce7266cce0194bd74df58b9d0e3f6df3a9fc8eb470d95c09d"
      },
      {
        "name": "rustix",
        "version": "0.38.44",
        "sha256": "fdb5bc1ae2baa591800df16c9ca78619bf65c0488b41b96ccec5d11220d8c154"
      },
      {
        "name": "rustix",
        "version": "1.1.4",
        "sha256": "b6fe4565b9518b83ef4f91bb47ce29620ca828bd32cb7e408f0062e9930ba190"
      },
      {
        "name": "rustls",
        "version": "0.23.40",
        "sha256": "ef86cd5876211988985292b91c96a8f2d298df24e75989a43a3c73f2d4d8168b"
      },
      {
        "name": "rustls-pki-types",
        "version": "1.14.1",
        "sha256": "30a7197ae7eb376e574fe940d068c30fe0462554a3ddbe4eca7838e049c937a9"
      },
      {
        "name": "rustls-webpki",
        "version": "0.103.13",
        "sha256": "61c429a8649f110dddef65e2a5ad240f747e85f7758a6bccc7e5777bd33f756e"
      },
      {
        "name": "rustversion",
        "version": "1.0.22",
        "sha256": "b39cdef0fa800fc44525c84ccb54a029961a8215f9619753635a9c0d2538d46d"
      },
      {
        "name": "schannel",
        "version": "0.1.29",
        "sha256": "91c1b7e4904c873ef0710c1f407dde2e6287de2bebc1bbbf7d430bb7cbffd939"
      },
      {
        "name": "scopeguard",
        "version": "1.2.0",
        "sha256": "94143f37725109f92c262ed2cf5e59bce7498c01bcc1502d7b9afe439a4e9f49"
      },
      {
        "name": "security-framework",
        "version": "3.7.0",
        "sha256": "b7f4bc775c73d9a02cde8bf7b2ec4c9d12743edf609006c7facc23998404cd1d"
      },
      {
        "name": "security-framework-sys",
        "version": "2.17.0",
        "sha256": "6ce2691df843ecc5d231c0b14ece2acc3efb62c0a398c7e1d875f3983ce020e3"
      },
      {
        "name": "semver",
        "version": "1.0.28",
        "sha256": "8a7852d02fc848982e0c167ef163aaff9cd91dc640ba85e263cb1ce46fae51cd"
      },
      {
        "name": "serde",
        "version": "1.0.228",
        "sha256": "9a8e94ea7f378bd32cbbd37198a4a91436180c5bb472411e48b5ec2e2124ae9e"
      },
      {
        "name": "serde-untagged",
        "version": "0.1.9",
        "sha256": "f9faf48a4a2d2693be24c6289dbe26552776eb7737074e6722891fadbe6c5058"
      },
      {
        "name": "serde-value",
        "version": "0.7.0",
        "sha256": "f3a1a3341211875ef120e117ea7fd5228530ae7e7036a779fdc9117be6b3282c"
      },
      {
        "name": "serde_core",
        "version": "1.0.228",
        "sha256": "41d385c7d4ca58e59fc732af25c3983b67ac852c1a25000afe1175de458b67ad"
      },
      {
        "name": "serde_derive",
        "version": "1.0.228",
        "sha256": "d540f220d3187173da220f885ab66608367b6574e925011a9353e4badda91d79"
      },
      {
        "name": "serde_ignored",
        "version": "0.1.14",
        "sha256": "115dffd5f3853e06e746965a20dcbae6ee747ae30b543d91b0e089668bb07798"
      },
      {
        "name": "serde_json",
        "version": "1.0.150",
        "sha256": "e8014e44b4736ed0538adeecded0fce2a272f22dc9578a7eb6b2d9993c74cfb9"
      },
      {
        "name": "serde_spanned",
        "version": "0.6.9",
        "sha256": "bf41e0cfaf7226dca15e8197172c295a782857fcb97fad1808a166870dee75a3"
      },
      {
        "name": "serde_spanned",
        "version": "1.1.1",
        "sha256": "6662b5879511e06e8999a8a235d848113e942c9124f211511b16466ee2995f26"
      },
      {
        "name": "sha1",
        "version": "0.10.6",
        "sha256": "e3bf829a2d51ab4a5ddf1352d8470c140cadc8301b2ae1789db023f01cedd6ba"
      },
      {
        "name": "shlex",
        "version": "2.0.1",
        "sha256": "f8fadd59c855ef2080decdef8ff161eb6661b86933c9d82e5ba29dc602a55aba"
      },
      {
        "name": "simd-adler32",
        "version": "0.3.9",
        "sha256": "703d5c7ef118737c72f1af64ad2f6f8c5e1921f818cdcb97b8fe6fc69bf66214"
      },
      {
        "name": "siphasher",
        "version": "0.3.11",
        "sha256": "38b58827f4464d87d377d175e90bf58eb00fd8716ff0a62f80356b5e61555d0d"
      },
      {
        "name": "slab",
        "version": "0.4.12",
        "sha256": "0c790de23124f9ab44544d7ac05d60440adc586479ce501c1d6d7da3cd8c9cf5"
      },
      {
        "name": "smallvec",
        "version": "1.15.2",
        "sha256": "8ed6a63f02c8539c91a8685a86f4099661ba3da017932f6ebbea6de3f0fa7c90"
      },
      {
        "name": "stable_deref_trait",
        "version": "1.2.1",
        "sha256": "6ce2be8dc25455e1f91df71bfa12ad37d7af1092ae736f3a6cd0e37bc7810596"
      },
      {
        "name": "strsim",
        "version": "0.11.1",
        "sha256": "7da8b5736845d9f2fcb837ea5d9e2628564b3b043a70948a3f0b778838c5fb4f"
      },
      {
        "name": "subtle",
        "version": "2.6.1",
        "sha256": "13c2bddecc57b384dee18652358fb23172facb8a2c51ccc10d74c157bdea3292"
      },
      {
        "name": "syn",
        "version": "2.0.117",
        "sha256": "e665b8803e7b1d2a727f4023456bbbbe74da67099c585258af0ad9c5013b9b99"
      },
      {
        "name": "synstructure",
        "version": "0.13.2",
        "sha256": "728a70f3dbaf5bab7f0c4b1ac8d7ae5ea60a4b5549c8a5914361c99147a709d2"
      },
      {
        "name": "tar",
        "version": "0.4.46",
        "sha256": "3f6221d9a6003c78398e3b239969f352578258df48c8eb051caadae0015bc840"
      },
      {
        "name": "tempfile",
        "version": "3.27.0",
        "sha256": "32497e9a4c7b38532efcdebeef879707aa9f794296a4f0244f6f69e9bc8574bd"
      },
      {
        "name": "thiserror",
        "version": "1.0.69",
        "sha256": "b6aaf5339b578ea85b50e080feb250a3e8ae8cfcdff9a461c9ec2904bc923f52"
      },
      {
        "name": "thiserror",
        "version": "2.0.18",
        "sha256": "4288b5bcbc7920c07a1149a35cf9590a2aa808e0bc1eafaade0b80947865fbc4"
      },
      {
        "name": "thiserror-impl",
        "version": "1.0.69",
        "sha256": "4fee6c4efc90059e10f81e6d42c60a18f76588c3d74cb83a0b242a2b6c7504c1"
      },
      {
        "name": "thiserror-impl",
        "version": "2.0.18",
        "sha256": "ebc4ee7f67670e9b64d05fa4253e753e016c6c95ff35b89b7941d6b856dec1d5"
      },
      {
        "name": "time",
        "version": "0.3.48",
        "sha256": "fc1aa89044e7786ffb2ec017acb22cb7de5b0be46d0f21aea2b224b8561e5db2"
      },
      {
        "name": "time-core",
        "version": "0.1.9",
        "sha256": "9e1c906769ad99c88eaa54e728060edef082f8e358ff32030cb7c7d315e81109"
      },
      {
        "name": "time-macros",
        "version": "0.2.28",
        "sha256": "9d3bfe86347f0cc659f586f01e26303ccd32418f26f30c7b0309b3ca3a07d695"
      },
      {
        "name": "tinystr",
        "version": "0.8.3",
        "sha256": "c8323304221c2a851516f22236c5722a72eaa19749016521d6dff0824447d96d"
      },
      {
        "name": "toml",
        "version": "0.8.23",
        "sha256": "dc1beb996b9d83529a9e75c17a1686767d148d70663143c7854d8b4a09ced362"
      },
      {
        "name": "toml",
        "version": "0.9.12+spec-1.1.0",
        "sha256": "cf92845e79fc2e2def6a5d828f0801e29a2f8acc037becc5ab08595c7d5e9863"
      },
      {
        "name": "toml_datetime",
        "version": "0.6.11",
        "sha256": "22cddaf88f4fbc13c51aebbf5f8eceb5c7c5a9da2ac40a13519eb5b0a0e8f11c"
      },
      {
        "name": "toml_datetime",
        "version": "0.7.5+spec-1.1.0",
        "sha256": "92e1cfed4a3038bc5a127e35a2d360f145e1f4b971b551a2ba5fd7aedf7e1347"
      },
      {
        "name": "toml_edit",
        "version": "0.22.27",
        "sha256": "41fe8c660ae4257887cf66394862d21dbca4a6ddd26f04a3560410406a2f819a"
      },
      {
        "name": "toml_parser",
        "version": "1.1.2+spec-1.1.0",
        "sha256": "a2abe9b86193656635d2411dc43050282ca48aa31c2451210f4202550afb7526"
      },
      {
        "name": "toml_write",
        "version": "0.1.2",
        "sha256": "5d99f8c9a7727884afe522e9bd5edbfc91a3312b36a77b5fb8926e4c31a41801"
      },
      {
        "name": "toml_writer",
        "version": "1.1.1+spec-1.1.0",
        "sha256": "756daf9b1013ebe47a8776667b466417e2d4c5679d441c26230efd9ef78692db"
      },
      {
        "name": "typeid",
        "version": "1.0.3",
        "sha256": "bc7d623258602320d5c55d1bc22793b57daff0ec7efc270ea7d55ce1d5f5471c"
      },
      {
        "name": "typenum",
        "version": "1.20.1",
        "sha256": "b6f5e870be6c3b371b77fe0ee0bafb859fa4964b4404c27de1d380043c4dda20"
      },
      {
        "name": "unicode-ident",
        "version": "1.0.24",
        "sha256": "e6e4313cd5fcd3dad5cafa179702e2b244f760991f45397d14d4ebf38247da75"
      },
      {
        "name": "unicode-segmentation",
        "version": "1.13.3",
        "sha256": "c6f5d3c3b1bf09027a88a6bc961fc00497d651009560b5463668dc81b0fa87a8"
      },
      {
        "name": "unicode-width",
        "version": "0.2.2",
        "sha256": "b4ac048d71ede7ee76d585517add45da530660ef4390e49b098733c6e897f254"
      },
      {
        "name": "unicode-xid",
        "version": "0.2.6",
        "sha256": "ebc1c04c71510c7f702b52b7c350734c9ff1295c464a03335b00bb84fc54f853"
      },
      {
        "name": "untrusted",
        "version": "0.9.0",
        "sha256": "8ecb6da28b8a351d773b68d5825ac39017e680750f980f3a1a85cd8dd28a47c1"
      },
      {
        "name": "ureq",
        "version": "2.12.1",
        "sha256": "02d1a66277ed75f640d608235660df48c8e3c19f3b4edb6a263315626cc3c01d"
      },
      {
        "name": "ureq",
        "version": "3.3.0",
        "sha256": "dea7109cdcd5864d4eeb1b58a1648dc9bf520360d7af16ec26d0a9354bafcfc0"
      },
      {
        "name": "ureq-proto",
        "version": "0.6.0",
        "sha256": "e994ba84b0bd1b1b0cf92878b7ef898a5c1760108fe7b6010327e274917a808c"
      },
      {
        "name": "url",
        "version": "2.5.8",
        "sha256": "ff67a8a4397373c3ef660812acab3268222035010ab8680ec4215f38ba3d0eed"
      },
      {
        "name": "utf8-zero",
        "version": "0.8.1",
        "sha256": "b8c0a043c9540bae7c578c88f91dda8bd82e59ae27c21baca69c8b191aaf5a6e"
      },
      {
        "name": "utf8_iter",
        "version": "1.0.4",
        "sha256": "b6c140620e7ffbb22c2dee59cafe6084a59b5ffc27a8859a5f0d494b5d52b6be"
      },
      {
        "name": "utf8parse",
        "version": "0.2.2",
        "sha256": "06abde3611657adf66d383f00b093d7faecc7fa57071cce2578660c9f1010821"
      },
      {
        "name": "vcpkg",
        "version": "0.2.15",
        "sha256": "accd4ea62f7bb7a82fe23066fb0957d48ef677f6eeb8215f372f52e48bb32426"
      },
      {
        "name": "version_check",
        "version": "0.9.5",
        "sha256": "0b928f33d975fc6ad9f86c8f283853ad26bdd5b10b7f1542aa2fa15e2289105a"
      },
      {
        "name": "walrus",
        "version": "0.26.4",
        "sha256": "3bfa49767bb3a9e1afb02aa95bbcbde8d82f2db4ca377afae94d688f14f62378"
      },
      {
        "name": "walrus-macro",
        "version": "0.26.0",
        "sha256": "1a9b0525d7ea6e5f906aca581a172e5c91b4c595290dfa8ad4a2bc9ffef33b44"
      },
      {
        "name": "wasi",
        "version": "0.11.1+wasi-snapshot-preview1",
        "sha256": "ccf3ec651a847eb01de73ccad15eb7d99f80485de043efb2f370cd654f4ea44b"
      },
      {
        "name": "wasip2",
        "version": "1.0.4+wasi-0.2.12",
        "sha256": "b67efb37e106e55ce722a510d6b5f9c17f083e5fc79afc2badeb12cc313d9487"
      },
      {
        "name": "wasip3",
        "version": "0.4.0+wasi-0.3.0-rc-2026-01-06",
        "sha256": "5428f8bf88ea5ddc08faddef2ac4a67e390b88186c703ce6dbd955e1c145aca5"
      },
      {
        "name": "wasm-bindgen",
        "version": "0.2.125",
        "sha256": "8ddb3f79143bced6de84270411622a2699cee572fc0875aeaf1e7867cf9fca1a"
      },
      {
        "name": "wasm-bindgen-cli-support",
        "version": "0.2.125",
        "sha256": "8106e743adc30550ed6b44d50442a0929efbaed693032b6c71f03ac0b0e860fe"
      },
      {
        "name": "wasm-bindgen-futures",
        "version": "0.4.75",
        "sha256": "503b14d284f2c8dac03b819967e155ea753f573586193b2b2c95990cb5d69280"
      },
      {
        "name": "wasm-bindgen-macro",
        "version": "0.2.125",
        "sha256": "4e21a184b13fb19e157296e2c46056aec9092264fab83e4ba59e68c61b323c3d"
      },
      {
        "name": "wasm-bindgen-macro-support",
        "version": "0.2.125",
        "sha256": "fecefd9c35bd935a20fc3fc344b5f29138961e4f47fb03297d88f2587afb5ebd"
      },
      {
        "name": "wasm-bindgen-shared",
        "version": "0.2.125",
        "sha256": "23939e44bb9a5d7576fa2b563dc2e136628f1224e88a8deed09e04858b77871f"
      },
      {
        "name": "wasm-encoder",
        "version": "0.244.0",
        "sha256": "990065f2fe63003fe337b932cfb5e3b80e0b4d0f5ff650e6985b1048f62c8319"
      },
      {
        "name": "wasm-encoder",
        "version": "0.245.1",
        "sha256": "3f9dca005e69bf015e45577e415b9af8c67e8ee3c0e38b5b0add5aa92581ed5c"
      },
      {
        "name": "wasm-metadata",
        "version": "0.244.0",
        "sha256": "bb0e353e6a2fbdc176932bbaab493762eb1255a7900fe0fea1a2f96c296cc909"
      },
      {
        "name": "wasmparser",
        "version": "0.205.0",
        "sha256": "1d457bb52804242e09d55a306e53ddbc65d1d29ed83db6a4eea3ed412ee0cfdf"
      },
      {
        "name": "wasmparser",
        "version": "0.244.0",
        "sha256": "47b807c72e1bac69382b3a6fb3dbe8ea4c0ed87ff5629b8685ae6b9a611028fe"
      },
      {
        "name": "wasmparser",
        "version": "0.245.1",
        "sha256": "4f08c9adee0428b7bddf3890fc27e015ac4b761cc608c822667102b8bfd6995e"
      },
      {
        "name": "webpki-root-certs",
        "version": "1.0.7",
        "sha256": "f31141ce3fc3e300ae89b78c0dd67f9708061d1d2eda54b8209346fd6be9a92c"
      },
      {
        "name": "webpki-roots",
        "version": "0.26.11",
        "sha256": "521bc38abb08001b01866da9f51eb7c5d647a19260e00054a8c7fd5f9e57f7a9"
      },
      {
        "name": "webpki-roots",
        "version": "1.0.7",
        "sha256": "52f5ee44c96cf55f1b349600768e3ece3a8f26010c05265ab73f945bb1a2eb9d"
      },
      {
        "name": "which",
        "version": "8.0.3",
        "sha256": "c789537cf2f7f55be8e6192f92e464174ee55f91af622777f7f1ceb0dbccd03e"
      },
      {
        "name": "winapi",
        "version": "0.3.9",
        "sha256": "5c839a674fcd7a98952e593242ea400abe93992746761e38641405d28b00f419"
      },
      {
        "name": "winapi-i686-pc-windows-gnu",
        "version": "0.4.0",
        "sha256": "ac3b87c63620426dd9b991e5ce0329eff545bccbbb34f3be09ff6fb6ab51b7b6"
      },
      {
        "name": "winapi-x86_64-pc-windows-gnu",
        "version": "0.4.0",
        "sha256": "712e227841d057c1ee1cd2fb22fa7e5a5461ae8e48fa2ca79ec42cfc1931183f"
      },
      {
        "name": "windows-link",
        "version": "0.2.1",
        "sha256": "f0805222e57f7521d6a62e36fa9163bc891acd422f971defe97d64e70d0a4fe5"
      },
      {
        "name": "windows-sys",
        "version": "0.48.0",
        "sha256": "677d2418bec65e3338edb076e806bc1ec15693c5d0104683f2efe857f61056a9"
      },
      {
        "name": "windows-sys",
        "version": "0.52.0",
        "sha256": "282be5f36a8ce781fad8c8ae18fa3f9beff57ec1b52cb3de0789201425d9a33d"
      },
      {
        "name": "windows-sys",
        "version": "0.59.0",
        "sha256": "1e38bc4d79ed67fd075bcc251a1c39b32a1776bbe92e5bef1f0bf1f8c531853b"
      },
      {
        "name": "windows-sys",
        "version": "0.61.2",
        "sha256": "ae137229bcbd6cdf0f7b80a31df61766145077ddf49416a728b02cb3921ff3fc"
      },
      {
        "name": "windows-targets",
        "version": "0.48.5",
        "sha256": "9a2fa6e2155d7247be68c096456083145c183cbbbc2764150dda45a87197940c"
      },
      {
        "name": "windows-targets",
        "version": "0.52.6",
        "sha256": "9b724f72796e036ab90c1021d4780d4d3d648aca59e491e6b98e725b84e99973"
      },
      {
        "name": "windows_aarch64_gnullvm",
        "version": "0.48.5",
        "sha256": "2b38e32f0abccf9987a4e3079dfb67dcd799fb61361e53e2882c3cbaf0d905d8"
      },
      {
        "name": "windows_aarch64_gnullvm",
        "version": "0.52.6",
        "sha256": "32a4622180e7a0ec044bb555404c800bc9fd9ec262ec147edd5989ccd0c02cd3"
      },
      {
        "name": "windows_aarch64_msvc",
        "version": "0.48.5",
        "sha256": "dc35310971f3b2dbbf3f0690a219f40e2d9afcf64f9ab7cc1be722937c26b4bc"
      },
      {
        "name": "windows_aarch64_msvc",
        "version": "0.52.6",
        "sha256": "09ec2a7bb152e2252b53fa7803150007879548bc709c039df7627cabbd05d469"
      },
      {
        "name": "windows_i686_gnu",
        "version": "0.48.5",
        "sha256": "a75915e7def60c94dcef72200b9a8e58e5091744960da64ec734a6c6e9b3743e"
      },
      {
        "name": "windows_i686_gnu",
        "version": "0.52.6",
        "sha256": "8e9b5ad5ab802e97eb8e295ac6720e509ee4c243f69d781394014ebfe8bbfa0b"
      },
      {
        "name": "windows_i686_gnullvm",
        "version": "0.52.6",
        "sha256": "0eee52d38c090b3caa76c563b86c3a4bd71ef1a819287c19d586d7334ae8ed66"
      },
      {
        "name": "windows_i686_msvc",
        "version": "0.48.5",
        "sha256": "8f55c233f70c4b27f66c523580f78f1004e8b5a8b659e05a4eb49d4166cca406"
      },
      {
        "name": "windows_i686_msvc",
        "version": "0.52.6",
        "sha256": "240948bc05c5e7c6dabba28bf89d89ffce3e303022809e73deaefe4f6ec56c66"
      },
      {
        "name": "windows_x86_64_gnu",
        "version": "0.48.5",
        "sha256": "53d40abd2583d23e4718fddf1ebec84dbff8381c07cae67ff7768bbf19c6718e"
      },
      {
        "name": "windows_x86_64_gnu",
        "version": "0.52.6",
        "sha256": "147a5c80aabfbf0c7d901cb5895d1de30ef2907eb21fbbab29ca94c5b08b1a78"
      },
      {
        "name": "windows_x86_64_gnullvm",
        "version": "0.48.5",
        "sha256": "0b7b52767868a23d5bab768e390dc5f5c55825b6d30b86c844ff2dc7414044cc"
      },
      {
        "name": "windows_x86_64_gnullvm",
        "version": "0.52.6",
        "sha256": "24d5b23dc417412679681396f2b49f3de8c1473deb516bd34410872eff51ed0d"
      },
      {
        "name": "windows_x86_64_msvc",
        "version": "0.48.5",
        "sha256": "ed94fce61571a4006852b7389a063ab983c02eb1bb37b47f8272ce92d06d9538"
      },
      {
        "name": "windows_x86_64_msvc",
        "version": "0.52.6",
        "sha256": "589f6da84c646204747d1270a2a5661ea66ed1cced2631d546fdfb155959f9ec"
      },
      {
        "name": "winnow",
        "version": "0.7.15",
        "sha256": "df79d97927682d2fd8adb29682d1140b343be4ac0f08fd68b7765d9c059d3945"
      },
      {
        "name": "winnow",
        "version": "1.0.3",
        "sha256": "0592e1c9d151f854e6fd382574c3a0855250e1d9b2f99d9281c6e6391af352f1"
      },
      {
        "name": "wit-bindgen",
        "version": "0.51.0",
        "sha256": "d7249219f66ced02969388cf2bb044a09756a083d0fab1e566056b04d9fbcaa5"
      },
      {
        "name": "wit-bindgen",
        "version": "0.57.1",
        "sha256": "1ebf944e87a7c253233ad6766e082e3cd714b5d03812acc24c318f549614536e"
      },
      {
        "name": "wit-bindgen-core",
        "version": "0.51.0",
        "sha256": "ea61de684c3ea68cb082b7a88508a8b27fcc8b797d738bfc99a82facf1d752dc"
      },
      {
        "name": "wit-bindgen-rust",
        "version": "0.51.0",
        "sha256": "b7c566e0f4b284dd6561c786d9cb0142da491f46a9fbed79ea69cdad5db17f21"
      },
      {
        "name": "wit-bindgen-rust-macro",
        "version": "0.51.0",
        "sha256": "0c0f9bfd77e6a48eccf51359e3ae77140a7f50b1e2ebfe62422d8afdaffab17a"
      },
      {
        "name": "wit-component",
        "version": "0.244.0",
        "sha256": "9d66ea20e9553b30172b5e831994e35fbde2d165325bec84fc43dbf6f4eb9cb2"
      },
      {
        "name": "wit-parser",
        "version": "0.205.0",
        "sha256": "a3db34c7688c161ed7bd1b2f8055dca9fb2c15201db58754e9c48a0805f32e5f"
      },
      {
        "name": "wit-parser",
        "version": "0.244.0",
        "sha256": "ecc8ac4bc1dc3381b7f59c34f00b67e18f910c2c0f50015669dde7def656a736"
      },
      {
        "name": "worker-codegen",
        "version": "0.2.0",
        "sha256": "47085d11f44223f7177f6dcd854d297eadeb79163a347fac38b61ed7ea919d2c"
      },
      {
        "name": "writeable",
        "version": "0.6.3",
        "sha256": "1ffae5123b2d3fc086436f8834ae3ab053a283cfac8fe0a0b8eaae044768a4c4"
      },
      {
        "name": "xattr",
        "version": "1.6.1",
        "sha256": "32e45ad4206f6d2479085147f02bc2ef834ac85886624a23575ae137c8aa8156"
      },
      {
        "name": "xz2",
        "version": "0.1.7",
        "sha256": "388c44dc09d76f1536602ead6d325eb532f5c122f17782bd57fb47baeeb767e2"
      },
      {
        "name": "yoke",
        "version": "0.8.3",
        "sha256": "709fe23a0424b6a435d82152b1bd3fdfb0833487d5fa90d05d42762a9891fef5"
      },
      {
        "name": "yoke-derive",
        "version": "0.8.2",
        "sha256": "de844c262c8848816172cef550288e7dc6c7b7814b4ee56b3e1553f275f1858e"
      },
      {
        "name": "zerofrom",
        "version": "0.1.8",
        "sha256": "0ec05a11813ea801ff6d75110ad09cd0824ddba17dfe17128ea0d5f68e6c5272"
      },
      {
        "name": "zerofrom-derive",
        "version": "0.1.7",
        "sha256": "11532158c46691caf0f2593ea8358fed6bbf68a0315e80aae9bd41fbade684a1"
      },
      {
        "name": "zeroize",
        "version": "1.9.0",
        "sha256": "e13c156562582aa81c60cb29407084cdb54c4164760106ab78e6c5b0858cf64e"
      },
      {
        "name": "zeroize_derive",
        "version": "1.5.0",
        "sha256": "3c50655cbb0fe3fc43170059e702f1ce5e19b84cec58dc87b037a09935c2f328"
      },
      {
        "name": "zerotrie",
        "version": "0.2.4",
        "sha256": "0f9152d31db0792fa83f70fb2f83148effb5c1f5b8c7686c3459e361d9bc20bf"
      },
      {
        "name": "zerovec",
        "version": "0.11.6",
        "sha256": "90f911cbc359ab6af17377d242225f4d75119aec87ea711a880987b18cd7b239"
      },
      {
        "name": "zerovec-derive",
        "version": "0.11.3",
        "sha256": "625dc425cab0dca6dc3c3319506e6593dcb08a9f387ea3b284dbd52a92c40555"
      },
      {
        "name": "zip",
        "version": "2.4.2",
        "sha256": "fabe6324e908f85a1c52063ce7aa26b68dcb7eb6dbc83a2d148403c9bc3eba50"
      },
      {
        "name": "zmij",
        "version": "1.0.21",
        "sha256": "b8848ee67ecc8aedbaf3e4122217aff892639231befc6a1b58d29fff4c2cabaa"
      },
      {
        "name": "zopfli",
        "version": "0.8.3",
        "sha256": "f05cd8797d63865425ff89b5c4a48804f35ba0ce8d125800027ad6017d2b5249"
      },
      {
        "name": "zstd",
        "version": "0.13.3",
        "sha256": "e91ee311a569c327171651566e07972200e76fcfe2242a4fa446149a3881c08a"
      },
      {
        "name": "zstd-safe",
        "version": "7.2.4",
        "sha256": "8f49c4d5f0abb602a93fb8736af2a4f4dd9512e36f7f570d66e65ff867ed3b9d"
      },
      {
        "name": "zstd-sys",
        "version": "2.0.16+zstd.1.5.7",
        "sha256": "91e19ebc2adc8f83e43039e79776e3fda8ca919132d68a1fed6a5faca2683748"
      }
    ],
    "apple": {
      "version": "27.0",
      "source": "https://developer.apple.com/xcode/"
    }
  },
  "entry": "scripts/build.mjs"
});
// Linux自动化与本机Build共同读取产品Cargo声明；两流程不互相导入。
import {readFileSync as readServeManifest} from 'node:fs';
import {fileURLToPath as serveFilePath} from 'node:url';
const serveManifest=readServeManifest(serveFilePath(new URL('../Cargo.toml',import.meta.url)),'utf8');
const serveToolRecords=[...serveManifest.matchAll(/^linux_tool_sources = '''([^']+)'''$/gmu)];
if(serveToolRecords.length!==1)throw Error('CitizenServe自动化工具唯一声明缺失或重复');
const serveTools=JSON.parse(serveToolRecords[0][1]);
for(const id of ['worker-build','wasm-bindgen','wasm-opt','protoc']){
 const target=contract.resources.tools[id],record=serveTools[id];
 if(target.version!==null||target.platforms['linux-x64']!==null||!record?.version||!record.archive?.url||!record.archive.sha256)
  throw Error('CitizenServe工具声明重复或缺失：'+id);
 target.version=record.version;target.platforms['linux-x64']=record.archive;
}


const targetRuntime=await(async()=>{
// 本产品的固定工作根与占用生命周期；不访问邻仓或调用方临时目录。
const {default:fs}=await import('node:fs');
const {dirname,join,resolve,parse,relative,sep}=await import('node:path');
const {fileURLToPath,pathToFileURL}=await import('node:url');
const {randomUUID}=await import('node:crypto');
const {AsyncLocalStorage}=await import('node:async_hooks');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const product='citizenserve';
const sessions=new AsyncLocalStorage();
const scopes=new Set(['build','test']);
const fail=message=>{throw Error(product+' target：'+message);};
function fixedWork(scope){
 if(scope==='build'||scope==='test')return join(root,'target',scope);
 if(typeof scope==='string'&&scope.startsWith('build/')){
  const platform=scope.slice(6);if(Object.hasOwn(contract.platforms,platform))return join(root,'target/build',platform);
 }
 fail('工作根用途无效');
}
function isBuildWork(work){return typeof work==='string'&&Object.keys(contract.platforms).some(platform=>work===fixedWork('build/'+platform));}
function validWork(work){return work===fixedWork('test')||isBuildWork(work);}
function directory(path,create=false){
 let at=parse(path).root;
 for(const part of relative(at,path).split(sep)){
  at=join(at,part);
  if(create&&!fs.existsSync(at))try{fs.mkdirSync(at,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const value=fs.lstatSync(at);if(!value.isDirectory()||value.isSymbolicLink()||fs.realpathSync(at)!==at)fail('工作目录经过链接或非目录');
 }
 return fs.lstatSync(path);
}
function checkFixedWork(work,{create=false}={}){
 if(typeof work!=='string'||!validWork(work))fail('工作根只允许本产品target/build或target/test固定目录');
 directory(work,create);return work;
}
function checkScratchPath(path){
 if(typeof path!=='string'||resolve(path)!==path||![fixedWork('test'),...Object.keys(contract.platforms).map(platform=>fixedWork('build/'+platform))].some(work=>path===work||path.startsWith(work+sep)))fail('内部物化目录越出本产品固定工作根');
 directory(path);return path;
}
function fixedScratch(prefix){
 const path=resolve(prefix.replace(/-$/,''));checkScratchPath(dirname(path));
 fs.mkdirSync(path,{mode:0o700});return directory(path)&&path;
}
function assertTargetTopology(){
 const target=join(root,'target');if(!fs.existsSync(target))return;
 directory(target);
 for(const name of fs.readdirSync(target))if(!scopes.has(name))fail('target含非固定目录或根部生成文件：'+name);
 for(const name of fs.readdirSync(target))directory(join(target,name));
}
function regular(path){const value=fs.lstatSync(path);if(!value.isFile()||value.isSymbolicLink()||value.nlink!==1||value.size>65536)fail('任务标记不是准确普通文件');return value;}
function readOwner(work){const path=join(work,'.active.json');if(!fs.existsSync(path))return null;regular(path);let value;try{value=JSON.parse(fs.readFileSync(path,'utf8'));}catch{fail('任务标记损坏，禁止清场');}
 if(value.schema!==1||value.product_id!==product||value.work!==work||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.nonce!=='string'||!Array.isArray(value.groups)||!value.groups.every(pid=>Number.isSafeInteger(pid)&&pid>1))fail('任务标记身份无效');return value;
}
function alive(pid,group=false){try{process.kill(group&&process.platform!=='win32'?-pid:pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;return true;}}
function writeOwner(owner){regular(join(owner.work,'.active.json'));fs.writeFileSync(join(owner.work,'.active.json'),JSON.stringify(owner)+'\n',{mode:0o600});}
function writable(path){const value=fs.lstatSync(path);if(value.isDirectory()&&!value.isSymbolicLink()){if(fs.realpathSync(path)!==path)fail('清理路径漂移');fs.chmodSync(path,value.mode|0o700);for(const name of fs.readdirSync(path))writable(join(path,name));}}
function removeTree(path){
 const state=fs.lstatSync(path);
 if(state.isSymbolicLink()){fs.unlinkSync(path);return;}
 if(state.isDirectory()){if(fs.realpathSync(path)!==path)fail('清理目录漂移');fs.chmodSync(path,state.mode|0o700);for(const name of fs.readdirSync(path))removeTree(join(path,name));fs.rmdirSync(path);return;}
 fs.unlinkSync(path);
}
function empty(work,keep=[]){
 const before=directory(work);
 for(const name of fs.readdirSync(work)){if(keep.includes(name))continue;const path=join(work,name);removeTree(path);}
 const after=directory(work);if(before.dev!==after.dev||before.ino!==after.ino||fs.readdirSync(work).some(name=>!keep.includes(name)))fail('固定工作目录未完全清空或被替换');
}
function short(work,action){const path=isBuildWork(work)?join(fixedWork('build'),'.claim-'+relative(fixedWork('build'),work)):join(work,'.claim.lock');try{fs.mkdirSync(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;
 const record=join(path,'owner.json');let holder=null;
 if(fs.existsSync(record)){regular(record);try{holder=JSON.parse(fs.readFileSync(record,'utf8'));}catch{fail('领取锁损坏');}}
 const active=readOwner(work);
 if(holder?(holder.work!==work||!Number.isSafeInteger(holder.pid)||alive(holder.pid)):(Date.now()-fs.lstatSync(path).mtimeMs<30000))fail('固定工作目录正在领取或收尾');
 if(active&&(alive(active.pid)||active.groups.some(pid=>alive(pid,true))))fail('固定工作目录仍有活跃进程');
 writable(path);fs.rmSync(path,{recursive:true});fs.mkdirSync(path,{mode:0o700});}
 fs.writeFileSync(join(path,'owner.json'),JSON.stringify({pid:process.pid,work})+'\n',{flag:'wx',mode:0o600});
 const before=directory(path);try{return action();}finally{const after=directory(path);if(before.dev!==after.dev||before.ino!==after.ino)fail('领取锁漂移');fs.unlinkSync(join(path,'owner.json'));fs.rmdirSync(path);}}
function clearFixedWork(work){
 checkFixedWork(work);const session=sessions.getStore(),owner=readOwner(work);
 if(owner&&(!session||session.owner.work!==work||session.owner.nonce!==owner.nonce))fail('固定工作目录属于其他活跃任务');
 if(owner&&owner.groups.some(pid=>alive(pid,true)))fail('工具后代退出未确认，禁止清场');
 if(fs.existsSync(join(work,'.product-build.lock')))fail('产品编译进程仍持有守卫，禁止清场');
 const value=short(work,()=>{empty(work,owner&&!(owner.state==='retained'&&owner.pid===process.pid)?['.active.json','.claim.lock']:['.claim.lock']);if(isBuildWork(work)&&fs.readdirSync(work).length===0)fs.rmdirSync(work);});return value;
}
function claimFixedWork(scope,{environment=process.env,retain=false}={}){
 const work=checkFixedWork(fixedWork(scope),{create:true}),current=sessions.getStore();
 if(current?.owner.work===work)return {...current,nested:true};
 const token=environment.PRODUCT_WORK_LEASE;
 return short(work,()=>{
  const previous=readOwner(work);
  if(previous){
   if(token===previous.nonce&&alive(previous.pid))return {owner:previous,nested:true,retain};
   if(previous.groups.some(pid=>alive(pid,true)))fail('上轮工具进程仍运行，禁止领取');
   if(previous.state==='retained')fail('结果尚未由调用方消费，禁止覆盖');
   if(alive(previous.pid))fail('固定工作目录已有活跃任务');
  }
  if(fs.existsSync(join(work,'.product-build.lock')))fail('产品守卫尚未释放，禁止覆盖');
  empty(work,['.claim.lock']);
 const lifecycle=environment.PRODUCT_LIFECYCLE_RUN;
 if(lifecycle!==undefined&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(lifecycle))fail('生命周期运行身份无效');
  const owner={schema:1,product_id:product,work,pid:process.pid,nonce:randomUUID(),groups:[],state:'running',...(lifecycle?{lifecycle_run:lifecycle}:{})};
  fs.writeFileSync(join(work,'.active.json'),JSON.stringify(owner)+'\n',{flag:'wx',mode:0o600});return {owner,retain};
 });
}
function trackFixedProcess(work,pid){
 if(!pid||!validWork(work))return;
 const owner=readOwner(work);if(!owner)return;
 if(owner.pid!==process.pid&&!(alive(owner.pid)&&process.env.PRODUCT_WORK_LEASE===owner.nonce))fail('工具进程不能写入其他任务');
 if(!owner.groups.includes(pid)){owner.groups.push(pid);writeOwner(owner);}
}
function trackWorkProcess(pid){
 const session=sessions.getStore();if(!session||!pid)return;
 const owner=readOwner(session.owner.work);if(owner?.nonce!==session.owner.nonce)fail('任务所有权漂移');
 if(!owner.groups.includes(pid)){owner.groups.push(pid);writeOwner(owner);}
}
function workEnvironment(environment=process.env){
 const session=sessions.getStore();if(!session)return environment;
 const work=session.owner.work,result={...environment,PRODUCT_WORK_LEASE:session.owner.nonce};
 for(const [key,name]of Object.entries({TMPDIR:'tmp',TMP:'tmp',TEMP:'tmp',CARGO_TARGET_DIR:'cargo',CARGO_HOME:'dependencies/cargo-home',npm_config_cache:'dependencies/npm',PUB_CACHE:'dependencies/pub',GRADLE_USER_HOME:'dependencies/gradle',XDG_CACHE_HOME:'cache',XDG_CONFIG_HOME:'config',CLANG_MODULE_CACHE_PATH:'cache/clang',SWIFT_MODULECACHE_PATH:'cache/swift'})){
  const supplied=result[key];
  if(supplied!==undefined&&typeof supplied!=='string')fail('可写环境目录无效：'+key);
  const local=supplied&&(resolve(supplied)===work||resolve(supplied).startsWith(work+sep));
  result[key]=local?supplied:join(work,name);directory(resolve(result[key]),true);
 }
 return result;
}
function prepareSourceView(){
 const session=sessions.getStore();if(!session)fail('工程视图缺少固定任务');
 const project=join(session.owner.work,'source');
 if(fs.existsSync(project)){directory(project);return project;}
 const omitted=new Set(['target','node_modules','build','dist','.dart_tool','.gradle','.symlinks','Pods','ephemeral','.cache','cache','tasks','tsconfig.tsbuildinfo']);
 // 逐个直接子项复制，Node禁止把整个根直接cp到自身的子目录。
 fs.mkdirSync(project,{mode:0o700});
 const include=path=>!omitted.has(path.slice(path.lastIndexOf(sep)+1))&&!['tools/shared','tools/archives','rely/objects'].some(prefix=>relative(root,path).split(sep).join('/')===prefix);
 for(const name of fs.readdirSync(root)){const source=join(root,name);if(include(source))fs.cpSync(source,join(project,name),{recursive:true,verbatimSymlinks:true,filter:include});}
 return directory(project)&&project;
}
function retainWork(){const session=sessions.getStore();if(!session)fail('缺少当前任务');session.retain=true;}
function releaseFixedWork(session,{unsafe=false}={}){
 if(session.nested)return;
 const work=session.owner.work;
 const value=short(work,()=>{
  const owner=readOwner(work);if(owner?.nonce!==session.owner.nonce)fail('任务所有权漂移');
  const groups=owner.groups.filter(pid=>alive(pid,true));
  if(unsafe||groups.length){writeOwner({...owner,groups,state:'unsafe'});fail('工具后代退出未确认，保留守卫并禁止任务完成');}
  if(session.retain){writeOwner({...owner,groups:[],state:'retained'});return;}
  if(fs.existsSync(join(work,'.product-build.lock')))fail('产品编译守卫未释放，禁止完成');
  empty(work,['.claim.lock']);if(isBuildWork(work))fs.rmdirSync(work);
 });return value;
}
function withFixedWorkSync(scope,action,options={}){
 const session=claimFixedWork(scope,options);let unsafe=false;
 try{return sessions.run(session,()=>action(session.owner.work,session));}
 catch(error){unsafe=String(error?.message).includes('退出未确认');throw error;}
 finally{releaseFixedWork(session,{unsafe});}
}
async function withFixedWork(scope,action,options={}){
 const session=claimFixedWork(scope,options);let unsafe=false;
 try{return await sessions.run(session,()=>action(session.owner.work,session));}
 catch(error){unsafe=String(error?.message).includes('退出未确认');throw error;}
 finally{releaseFixedWork(session,{unsafe});}
}
// 调用方在消费结果且产品进程退出后，只能收尾这个产品的准确固定目录。
function finishFixedWork(work,{run_id}={}){
 checkFixedWork(work);
 const value=short(work,()=>{
  const owner=readOwner(work);if(owner){
   if(alive(owner.pid)||owner.groups.some(pid=>alive(pid,true)))fail('产品进程退出未确认');
  }
  if(fs.existsSync(join(work,'.product-build.lock')))fail('产品守卫尚未释放');
  if(run_id&&fs.existsSync(join(work,'build-result.json'))){regular(join(work,'build-result.json'));if(JSON.parse(fs.readFileSync(join(work,'build-result.json'),'utf8')).run_id!==run_id)fail('结果任务编号不符');}
  empty(work,['.claim.lock']);if(isBuildWork(work))fs.rmdirSync(work);
 });return value;
}
// 前置测试退出后的恢复只接受同一随机运行身份；活跃或未知所有权不清理。
function finishLifecycleWork(scope,run){
 if(typeof run!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(run))fail('生命周期收尾身份无效');
 const work=fixedWork(scope);if(!fs.existsSync(work))return;checkFixedWork(work);
 const active=readOwner(work),lock=join(work,'.product-build.lock');
 let build=null;if(fs.existsSync(lock)){regular(lock);build=JSON.parse(fs.readFileSync(lock,'utf8'));}
 const markers=[active,build].filter(Boolean);
 if(!markers.some(owner=>owner.lifecycle_run===run))return;
 if(build&&(build.schema!==1||build.platform!=='cloudflare'||build.flow!=='build'||typeof build.nonce!=='string'))fail('生命周期Build身份无效');
 if(markers.some(owner=>owner.lifecycle_run!==run||owner.work!==work||owner.product_id!==product||
  !Number.isSafeInteger(owner.pid)||owner.pid<1||alive(owner.pid)||owner.supply_quiet===false||
  (owner.groups||[]).some(pid=>alive(pid,true))))fail('生命周期进程退出或所有权未确认');
 short(work,()=>{
  const current=readOwner(work);let currentBuild=null;
  if(fs.existsSync(lock)){regular(lock);currentBuild=JSON.parse(fs.readFileSync(lock,'utf8'));}
  if(JSON.stringify(current)!==JSON.stringify(active)||JSON.stringify(currentBuild)!==JSON.stringify(build))fail('生命周期收尾所有权漂移');
  empty(work,['.claim.lock']);
 });
 if(isBuildWork(work))fs.rmdirSync(work);
}
function taskScope(work){checkFixedWork(work);return work===fixedWork('test')?'test':'build/'+relative(fixedWork('build'),work);}

// 正式实现结束；仅直接使用 node --test 执行本文件时注册以下回归。
if(inlineTestEntry&&process.env.PRODUCT_TEST_SCOPE!=='contracts') {
// 本产品真实固定目录入口的领取、并发拒绝、失败收尾与恢复验收。
const {default:test} = await import('node:test');
const {default:assert} = await import('node:assert/strict');
const {default:fs} = await import('node:fs');
const {join} = await import('node:path');
const {execFileSync} = await import('node:child_process');

const root=join(import.meta.dirname,'..');
const isEmpty=()=>assert.deepEqual(fs.readdirSync(fixedWork('test')),[]);

// 各平台并发领取自己的工作根，正常退出后只删除本平台目录。
test('平台编译现场独立领取且结束删除',async()=>{
 const platforms=Object.keys(contract.platforms).slice(0,2),joined=[];let release;const both=new Promise(resolve=>{release=resolve;});
 await Promise.all(platforms.map(platform=>withFixedWork('build/'+platform,async work=>{
  fs.writeFileSync(join(work,'platform'),platform);joined.push(platform);if(joined.length===platforms.length)release();
  await both;assert.equal(fs.readFileSync(join(work,'platform'),'utf8'),platform);
 })));
 assert.deepEqual(joined.sort(),platforms.sort());for(const platform of platforms)assert.equal(fs.existsSync(fixedWork('build/'+platform)),false);
});

test('固定根拒绝任意任务目录、平台目录和外部临时根',()=>{
 for(const path of [join(root,'target'),join(root,'target/test/other'),join(root,'target/macos/test'),join(root,'target/build/run-123'),'/tmp/test'])assert.throws(()=>checkFixedWork(path),/固定目录/);
});
test('成功入口清空全部现场并保留固定目录',async()=>{
 await withFixedWork('test',async work=>{fs.mkdirSync(join(work,'dependencies'));fs.writeFileSync(join(work,'dependencies/fixture'),'input');fs.chmodSync(join(work,'dependencies'),0o555);});isEmpty();assertTargetTopology();
});
test('失败入口同样清空，不由测试代替被测入口清理',async()=>{
 await assert.rejects(withFixedWork('test',async work=>{fs.writeFileSync(join(work,'partial'),'partial');throw Error('synthetic failure');}),/synthetic failure/);isEmpty();
});
test('第二个真实进程不能领取活跃固定根或清理前一任务',async()=>{
 await withFixedWork('test',async work=>{
  fs.writeFileSync(join(work,'sentinel'),'owned');
  const module=join(import.meta.dirname,'build.mjs');
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e','import {withFixedWork} from '+JSON.stringify(module)+'; await withFixedWork("test",()=>{});'],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']}),/活跃任务/);
  assert.equal(fs.readFileSync(join(work,'sentinel'),'utf8'),'owned');
 });isEmpty();
});
test('活跃标记损坏时拒绝覆盖和清理',async()=>{
 await withFixedWork('test',async work=>{const path=join(work,'.active.json'),bytes=fs.readFileSync(path);fs.writeFileSync(path,'{}');try{assert.throws(()=>finishFixedWork(work),/身份无效/);}finally{fs.writeFileSync(path,bytes);}});isEmpty();
});
test('嵌套内部步骤使用同一个任务，外层结束才清空',async()=>{
 await withFixedWork('test',async work=>{await withFixedWork('test',async inner=>{assert.equal(inner,work);fs.writeFileSync(join(work,'nested'),'owned');});assert.equal(fs.readFileSync(join(work,'nested'),'utf8'),'owned');});isEmpty();
});

test('真实工具超时和取消后停止进程组并清场',async()=>{
 const {runResourceProcess}=await import('./build.mjs');
 const run=(work,signal,timeout)=>import('./build.mjs').then(({runTool})=>runTool(process.execPath,['-e','setInterval(()=>{},1000)'],{work,cwd:work,signal,timeout,tools:{node:process.execPath}}));
 for(const kind of ['timeout','cancel']){await assert.rejects(withFixedWork('test',async work=>{fs.writeFileSync(join(work,'partial'),'partial');const abort=new AbortController();const timer=kind==='cancel'?setTimeout(()=>abort.abort(Error('synthetic cancel')),50):null;try{await run(work,abort.signal,kind==='timeout'?50:10000);}finally{clearTimeout(timer);}}),/超时|取消|synthetic cancel|失败|未完整成功/);isEmpty();}
});

test('清场删除断开的链接且不跟随链接删除其它固定根',async()=>{
 await withFixedWork('test',async testWork=>{const keep=join(testWork,'keep');fs.writeFileSync(keep,'protected');await withFixedWork('build/'+Object.keys(contract.platforms)[0],async buildWork=>{fs.symlinkSync(keep,join(buildWork,'external'));fs.symlinkSync(join(buildWork,'missing'),join(buildWork,'broken'));});assert.equal(fs.readFileSync(keep,'utf8'),'protected');assert.equal(fs.existsSync(fixedWork('build/'+Object.keys(contract.platforms)[0])),false);});isEmpty();
});

test('实际任务被强制终止后下一轮在同一固定根恢复并清场',async()=>{
 const {spawn}=await import('node:child_process');
 const module=join(import.meta.dirname,'build.mjs');
 const code='import {withFixedWork} from '+JSON.stringify(module)+';import fs from "node:fs";await withFixedWork("test",async work=>{fs.writeFileSync(work+"/interrupted","partial");process.stdout.write("ready");await new Promise(()=>{setInterval(()=>{},1000);});});';
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
 const finished=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('任务领取超时')),5000);child.once('error',reject);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});});child.kill('SIGKILL');assert.equal((await finished).signal,'SIGKILL');
  assert.equal(fs.readFileSync(join(fixedWork('test'),'interrupted'),'utf8'),'partial');
  await withFixedWork('test',async work=>{assert.equal(fs.existsSync(join(work,'interrupted')),false);fs.writeFileSync(join(work,'next'),'new task');});isEmpty();
 }finally{child.kill('SIGKILL');await finished;}
});

// 工程副本属于同一固定根；实际复制输入且不递归复制target。
test('真实工程视图进入当前固定根并在入口完成后清空',async()=>{
 const {prepareSourceView}=await import('./build.mjs');
 const before=fs.readFileSync(join(root,'scripts/build.mjs'));
 await withFixedWork('test',async work=>{
  const project=prepareSourceView();assert.equal(project,join(work,'source'));
  assert.deepEqual(fs.readFileSync(join(project,'scripts/build.mjs')),before);
  assert.equal(fs.existsSync(join(project,'target')),false);
  assert.equal(prepareSourceView(),project);
 });isEmpty();assert.deepEqual(fs.readFileSync(join(root,'scripts/build.mjs')),before);
});

// 流程身份独立保存；前置阶段使用真实固定根检查互斥和入口收尾。
test('流程领取使用本产品固定build并保护链接外文件',async()=>{
 const {claimWork}=await import('./build.mjs');
 await withFixedWork('test',async parent=>{
  const work=fixedWork('build/cloudflare'),fixture=fs.mkdtempSync(join(parent,'flow-protected-'));
  fs.writeFileSync(join(fixture,'keep'),'keep');let active;
  try{
   active=await claimWork('build','123');assert.equal(active.work,work);
   fs.symlinkSync(fixture,join(work,'link'));
   await assert.rejects(claimWork('build','124'),/活跃/);
   await active.finish();active=null;
   assert.equal(fs.readFileSync(join(fixture,'keep'),'utf8'),'keep');
   active=await claimWork('build','124');await active.finish();active=null;
   assert.equal(fs.existsSync(work),false);
  }finally{if(active)await active.finish();}
 });isEmpty();
});
// 直接调用同一生产模块的两类领取入口；被拒绝的入口不得改写任何活跃字节。
test('产品流程与本机编译在固定根双向拒绝活跃现场，候选与同时领取互斥',async()=>{
 const fs=await import('node:fs/promises'),{fixedWork}=await import('./build.mjs'),{claimBuildWork}=await import('./build.mjs');
 const {claimWork}=await import('./build.mjs');
 const work=fixedWork('build/cloudflare'),sentinel=join(work,'candidate');let task;
 try{
 task=await claimWork('build','ci-active');await fs.writeFile(sentinel,'自动化结果');const active=await fs.readFile(join(work,'.active.json'));
 await assert.rejects(claimBuildWork('build-blocked',work),/活跃/);assert.deepEqual(await fs.readFile(join(work,'.active.json')),active);assert.equal(await fs.readFile(sentinel,'utf8'),'自动化结果');
 await task.finish();task=null;
 task=await claimBuildWork('build-active',work);await fs.writeFile(sentinel,'Build候选');let marker=await fs.readFile(join(work,'.product-build.lock'));
 await assert.rejects(claimWork('build','release-blocked'),/活跃|守卫/);assert.deepEqual(await fs.readFile(join(work,'.product-build.lock')),marker);assert.equal(await fs.readFile(sentinel,'utf8'),'Build候选');
 await task.ready();marker=await fs.readFile(join(work,'.product-build.lock'));
 await assert.rejects(claimWork('build','ci-before-confirmation'),/活跃|守卫/);assert.deepEqual(await fs.readFile(join(work,'.product-build.lock')),marker);
 await task.finish();task=null;task=await claimWork('build','release-after-close');await task.finish();task=null;
 const race=await Promise.allSettled([claimWork('build','race-ci'),claimBuildWork('race-build',work)]);
 assert.equal(race.filter(value=>value.status==='fulfilled').length,1);assert.equal(race.filter(value=>value.status==='rejected').length,1);
 task=race.find(value=>value.status==='fulfilled').value;await task.finish();task=null;await assert.rejects(fs.lstat(work),{code:'ENOENT'});
 }finally{if(task)await task.finish();}
});
// 真实被杀进程留下的标记仍按本次身份恢复；不同身份和活进程不会被清理。
test('生命周期恢复只清理同轮已退出任务和Build守卫',async()=>{
 const {spawn}=await import('node:child_process');
 for(const kind of ['task','build']){
  const run=randomUUID(),work=fixedWork(kind==='task'?'test':'build/cloudflare');
  const body=kind==='task'
   ?'import {withFixedWork} from '+JSON.stringify(join(import.meta.dirname,'build.mjs'))+';await withFixedWork("test",async work=>{'
   :'import {claimBuildWork} from '+JSON.stringify(join(import.meta.dirname,'build.mjs'))+';await claimBuildWork("recovery",'+JSON.stringify(work)+');{';
  const code=body+'process.stdout.write("ready");await new Promise(()=>setInterval(()=>{},1000));}'+(kind==='task'?');':'');
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH,PRODUCT_LIFECYCLE_RUN:run,PRODUCT_TEST_SCOPE:'lifecycle'},stdio:['ignore','pipe','pipe']});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  let timer;
  try{
   await new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(Error('生命周期任务领取超时')),5000);
    child.once('error',reject);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});
    child.once('close',()=>reject(Error('生命周期子进程提前退出')));
   });
   assert.throws(()=>finishLifecycleWork(kind==='task'?'test':'build/cloudflare',run),/退出或所有权未确认/);
   child.kill('SIGKILL');assert.equal((await closed).signal,'SIGKILL');
   const before=fs.readdirSync(work);finishLifecycleWork(kind==='task'?'test':'build/cloudflare',randomUUID());assert.deepEqual(fs.readdirSync(work),before);
   finishLifecycleWork(kind==='task'?'test':'build/cloudflare',run);if(kind==='task')assert.deepEqual(fs.readdirSync(work),[]);else assert.equal(fs.existsSync(work),false);
  }finally{clearTimeout(timer);child.kill('SIGKILL');await closed;finishLifecycleWork(kind==='task'?'test':'build/cloudflare',run);}
 }
});

// 预留平台入口实际领取build；同样只在资源占用之前验证真实失败和收尾。


}

return Object.freeze({fixedWork,checkFixedWork,checkScratchPath,fixedScratch,assertTargetTopology,clearFixedWork,claimFixedWork,trackFixedProcess,trackWorkProcess,workEnvironment,prepareSourceView,retainWork,releaseFixedWork,withFixedWorkSync,withFixedWork,finishFixedWork,finishLifecycleWork,taskScope});
})();
export const {fixedWork,checkFixedWork,checkScratchPath,fixedScratch,assertTargetTopology,clearFixedWork,claimFixedWork,trackFixedProcess,trackWorkProcess,workEnvironment,prepareSourceView,retainWork,releaseFixedWork,withFixedWorkSync,withFixedWork,finishFixedWork,finishLifecycleWork,taskScope}=targetRuntime;

const resourceRuntime=await(async()=>{
const {claimFixedWork,releaseFixedWork,trackFixedProcess,fixedWork,checkFixedWork,finishLifecycleWork}=targetRuntime;
const {readFileSync}=await import('node:fs');
// 聊天协议资源配方归本产品；控制台供给与独立准备共用同一声明及验真。
const {createHash, randomUUID}=await import('node:crypto');
const {spawn}=await import('node:child_process');
const {inflateRawSync, gunzipSync, gzipSync, zstdDecompressSync}=await import('node:zlib');
const {lstat, realpath, readFile, writeFile, mkdir, rename, rm, link, readdir, chmod}=await import('node:fs/promises');
const {basename, dirname, isAbsolute, join, resolve, sep}=await import('node:path');
const {fileURLToPath}=await import('node:url');
const {Socket}=await import('node:net');

const unsafeWork = new Set();
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fail = message => { throw Error('聊天资源：' + message); };
const localSdkMode=()=>process.env.PRODUCT_SDK_SOURCE_MODE!=='git'&&process.env.GITHUB_ACTIONS!=='true';
async function localProtocolRoot(){const sdk=join(dirname(root),'tatachatsdk'),manifest=join(sdk,'pubspec.yaml');
 await checked(sdk,'directory');await checked(manifest,'file');
 if(!/^name: tatachat_sdk\r?$/mu.test(await readFile(manifest,'utf8')))fail('本地TataChatSDK仓库身份无效');return sdk;}
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (base, value) => value.startsWith(base + sep);

// 父路径逐层核验，拒绝链接、特殊文件、硬链接及不规范路径。
async function checked(path, kind, create = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('路径必须是规范绝对路径');
  if (create) {
    const parent = dirname(path);
    if (parent === path) fail('资源根无效');
    await checked(parent, 'directory');
    try { await mkdir(path, {mode: 0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  for (let at = path; ; at = dirname(at)) {
    const info = await lstat(at);
    if (info.isSymbolicLink() || await realpath(at) !== at) fail('路径经过链接');
    if (at === path) {
      if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) fail('资源类型无效');
    } else if (!info.isDirectory()) fail('父路径不是目录');
    if (dirname(at) === at) break;
  }
  return path;
}
async function declaration(sourceMode=localSdkMode()?'local':'git') {
  const data=structuredClone(contract);
  if (data.schema !== 1 || data.product_id !== 'citizenserve' || !data.tatachat) fail('所属产品声明缺失');
  const value = data.tatachat;
  if (sourceMode==='git'&&(!/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9-]+\.git$/u.test(value.protocol?.source)
      || !/^[a-f0-9]{40}$/u.test(value.protocol.commit)
      || value.protocol.files?.length !== 3
      || new Set(value.protocol.files.map(x => x.name)).size !== 3)) fail('固定协议来源无效');
  for (const file of sourceMode==='local'?[]:value.protocol.files) {
    if (!/^[a-z_]+\.proto$/u.test(file.name) || file.source_path !== 'lib/protocol/' + file.name
        || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 65536) fail('协议条目无效');
  }
  const archive = value.protoc?.archives?.[process.platform + '-' + process.arch];
  if (value.protoc?.id !== 'protoc' || value.protoc.version !== '35.0'
      || !archive || !/^https:\/\/github\.com\/protocolbuffers\/protobuf\/releases\/download\/v35\.0\/protoc-35\.0-[a-z0-9_-]+\.zip$/u.test(archive.url)
      || !/^[a-f0-9]{64}$/u.test(archive.sha256)) fail('当前宿主没有获准protoc原件');
  return {value, archive};
}
async function workDirectory(work) {
  await checked(work, 'directory');
  const base = join(root, 'target');
  if (!inside(base, work) || !['build', 'test'].includes(work.slice(base.length + 1).split(sep)[0])) fail('工作目录越界');
  return work;
}
async function protocolRequirements(sourceMode=localSdkMode()?'local':'git') {
  if(!['local','git'].includes(sourceMode))fail('协议来源模式无效');
  const {value, archive} = await declaration(sourceMode);
  if(sourceMode==='local'){
    const sdk=await localProtocolRoot(),files=[];
    for(const name of ['message.proto','attachment.proto','chat_frame.proto']){
      const path=join(sdk,'lib/protocol',name);await checked(path,'file');const bytes=await readFile(path);
      if(bytes.length<1||bytes.length>65536)fail('本地聊天协议大小无效');
      files.push({name,bytes:bytes.length,sha256:digest(bytes),local_path:path});
    }
    return {schema:1,product_id:'citizenserve',platform:'cloudflare',source_mode:'local',
      locks:[{ecosystem:'cargo',path:'Cargo.lock'},{ecosystem:'npm',path:'test/worker/package-lock.json',purpose:'worker_runtime_tests'}],
      tools:[{...value.protoc,archives:undefined,archive}],archives:files};
  }
  const repository = value.protocol.source.slice('https://github.com/'.length, -4);
  return {schema: 1, product_id: 'citizenserve', platform: 'cloudflare',
    locks: [{ecosystem: 'cargo', path: 'Cargo.lock'}, {ecosystem: 'npm', path: 'test/worker/package-lock.json', purpose:'worker_runtime_tests'}],
    tools: [{...value.protoc, archives: undefined, archive}],
    archives: value.protocol.files.map(file => ({name: file.name, bytes: file.bytes, sha256: file.sha256,
      url: 'https://raw.githubusercontent.com/' + repository + '/' + value.protocol.commit + '/' + file.source_path}))};
}

// 只提取固定可执行文件；归档先验真，禁止执行自解压、PATH解压器或归档内脚本。
function protocBytes(zip) {
  if (zip.length > 32 * 1024 ** 2) fail('protoc归档超限');
  let end = -1;
  for (let n = zip.length - 22; n >= Math.max(0, zip.length - 65557); n--) {
    if (zip.readUInt32LE(n) === 0x06054b50 && n + 22 + zip.readUInt16LE(n + 20) === zip.length) { end = n; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)
      || zip.readUInt16LE(end + 8) !== zip.readUInt16LE(end + 10)) fail('ZIP目录无效');
  const count = zip.readUInt16LE(end + 10), size = zip.readUInt32LE(end + 12), start = zip.readUInt32LE(end + 16);
  if (count > 4096 || start + size !== end) fail('ZIP目录越界');
  let at = start, result;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== 0x02014b50) fail('ZIP条目损坏');
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20), length = zip.readUInt32LE(at + 24);
    const names = zip.readUInt16LE(at + 28), extras = zip.readUInt16LE(at + 30), comments = zip.readUInt16LE(at + 32);
    const next = at + 46 + names + extras + comments;
    if (next > end || zip.readUInt16LE(at + 34)) fail('ZIP条目越界');
    const nameBytes = zip.subarray(at + 46, at + 46 + names), name = nameBytes.toString('utf8');
    if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.')) fail('ZIP路径无效');
    if (name === 'bin/protoc') {
      const mode = zip.readUInt32LE(at + 38) >>> 16, offset = zip.readUInt32LE(at + 42);
      if (result || flags & 1 || ![0, 8].includes(method) || length > 32 * 1024 ** 2 || length < 1
          || mode && (mode & 0xf000) !== 0x8000 || offset + 30 > start || zip.readUInt32LE(offset) !== 0x04034b50) fail('protoc条目无效');
      const localNames = zip.readUInt16LE(offset + 26), localExtras = zip.readUInt16LE(offset + 28);
      const begin = offset + 30 + localNames + localExtras;
      if (begin + packed > start || !zip.subarray(offset + 30, offset + 30 + localNames).equals(nameBytes)
          || zip.readUInt16LE(offset + 6) !== flags || zip.readUInt16LE(offset + 8) !== method) fail('ZIP本地头不一致');
      const data = zip.subarray(begin, begin + packed);
      result = method === 0 ? Buffer.from(data) : inflateRawSync(data, {maxOutputLength: 32 * 1024 ** 2});
      if (result.length !== length) fail('protoc展开大小不符');
    }
    at = next;
  }
  if (at !== end || !result) fail('protoc入口缺失');
  return result;
}
async function bounded(path, maximum) {
  await checked(path, 'file');
  if ((await lstat(path)).size > maximum) fail('资源超限');
  const bytes = await readFile(path);
  if (bytes.length > maximum) fail('读取资源超限');
  return bytes;
}
async function archive(path, entry, maximum) {
  return bounded(path, maximum);
}
async function fetchOriginal(entry, store, {offline, signal, fetcher}) {
  const destination = join(store, entry.sha256 + '.blob');
  try { await lstat(destination); return await archive(destination, entry, 32 * 1024 ** 2); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (offline) fail('离线缺少固定原件');
  signal?.throwIfAborted();
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  let url = entry.url, response;
  for (let n = 0; n <= 5; n++) {
    response = await fetcher(url, {signal: requestSignal, redirect: 'manual', credentials: 'omit'});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || n === 5) fail('官方资源重定向无效');
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.username || next.password || next.hash
        || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) fail('官方资源重定向越界');
    url = next.href;
  }
  if (!response.ok || !response.body) fail('官方固定资源获取失败');
  const chunks = []; let count = 0;
  for await (const chunk of response.body) {
    requestSignal.throwIfAborted(); count += chunk.length;
    if (count > 32 * 1024 ** 2) fail('官方资源超限');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const temporary = join(store, '.' + randomUUID() + '.pending');
  try {
    await writeFile(temporary, bytes, {flag: 'wx', mode: 0o444});
    signal?.throwIfAborted();
    // 同摘要提交是短暂原子操作；不锁住下载，不覆盖任何已有原件。
    try { await link(temporary, destination); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  } finally { await rm(temporary, {force: true}); }
  return archive(destination, entry, 32 * 1024 ** 2);
}
async function prepare({work, mode, store, toolStore = store, supply, offline = false, signal, fetcher = fetch}) {
  await workDirectory(work);
  if (!['independent', 'console'].includes(mode)) fail('供给模式必须显式选择');
  const requested = await protocolRequirements(), local = requested.source_mode === 'local';
  let originals, executable, originalPath;
  if (mode === 'console') {
    // 控制台必须先按公开需求准备供给；缺件、损坏或越界绝不自行下载。
    if (!supply || supply.schema !== 1 || supply.product_id !== 'citizenserve'
        || supply.platform !== 'cloudflare' || supply.work !== work) fail('控制台供给身份不符');
    if (!local) await checked(supply.dependency_root, 'directory');
    await checked(supply.tool_root, 'directory');
    originalPath = supply.protoc_archive;
    if (!inside(supply.tool_root, originalPath) || !inside(supply.tool_root, supply.protoc) && !inside(work, supply.protoc)) fail('工具供给越界');
    executable = protocBytes(await archive(originalPath, requested.tools[0].archive, 32 * 1024 ** 2));
    originals = [];
    for (const entry of requested.archives) {
      signal?.throwIfAborted();
      if(local){
        await checked(entry.local_path,'file');const bytes=await readFile(entry.local_path);
        if(bytes.length!==entry.bytes||digest(bytes)!==entry.sha256)fail('本地聊天协议读取期间变化');
        originals.push(bytes);
      }else{
        const path = supply.protocol?.[entry.name];
        if (!inside(supply.dependency_root, path ?? '')) fail('协议供给越界');
        originals.push(await archive(path, entry, 65536));
      }
    }
  } else {
    if (supply) fail('独立模式不混入控制台供给');
    signal?.throwIfAborted();
    if (!local) await originalStore(store, work);
    const options = {offline, signal, fetcher};
    const entry = requested.tools[0].archive;
    if (local || toolStore !== store) await originalStore(toolStore, work);
    executable = protocBytes(await fetchOriginal(entry, toolStore, options));
    originalPath = join(toolStore, entry.sha256 + '.blob'); originals = [];
    for (const file of requested.archives){
      if(local){
        await checked(file.local_path,'file');const bytes=await readFile(file.local_path);
        if(bytes.length!==file.bytes||digest(bytes)!==file.sha256)fail('本地聊天协议读取期间变化');
        originals.push(bytes);
      }else originals.push(await fetchOriginal(file, store, options));
    }
  }
  const destination = join(work, 'tatachat-protocol');
  try {
    await lstat(destination);
    const receipt = JSON.parse(await bounded(join(destination, 'receipt.json'),65536));
    if (receipt.work !== work) fail('已有协议准备身份不符');
    return receipt;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const pending = join(work, '.tatachat-protocol-' + randomUUID());
  await mkdir(pending, {mode: 0o700});
  try {
    const protocol = join(pending, 'protocol'); await mkdir(protocol, {mode: 0o700});
    for (let n = 0; n < originals.length; n++) await writeFile(join(protocol, requested.archives[n].name), originals[n], {flag: 'wx', mode: 0o444});
    const protoc = join(destination, 'protoc');
    await writeFile(join(pending, 'protoc'), executable, {flag: 'wx', mode: 0o555});
    const receipt = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', work, mode,
      protocol: join(destination, 'protocol'), files:requested.archives.map(item=>item.name), protoc, protoc_archive: originalPath,
      };
    await writeFile(join(pending, 'receipt.json'), JSON.stringify(receipt) + '\n', {flag: 'wx', mode: 0o444});
    signal?.throwIfAborted(); await rename(pending, destination);
    return receipt;
  } finally { await rm(pending, {recursive: true, force: true}); }
}
// 运行现场接收已验真的锁定npm闭包，不在源码目录安装依赖，也不下载或更新锁。
async function workerTestView(receiptPath,work){
  await workDirectory(work);
  const r=JSON.parse(await bounded(receiptPath,16*1024*1024)),view=join(work,'worker-smoke'),modules=join(view,'test/worker/node_modules');
  const scope=work.slice(join(root,'target').length+1).split(sep)[0],flow=r.flow;
  if(!['build','test'].includes(flow)||(flow==='test'?'test':'build')!==scope)fail('Worker供给流程与固定现场不符');
  if(r.schema!==1||r.product_id!=='citizenserve'||r.platform!=='cloudflare'||r.work!==work||r.modules!==modules)fail('Worker供给身份不符');
  await checked(modules,'directory');
  // 只物化测试输入与实际打包产物；不是第二Git检出或开发源码真源。
  async function directory(path){try{return await checked(path,'directory');}catch(e){if(e.code!=='ENOENT')throw e;await directory(dirname(path));await mkdir(path,{mode:0o700});return checked(path,'directory');}}
  async function copy(from,to){const st=await lstat(from);if(st.isDirectory()){await checked(from,'directory');await directory(to);for(const name of await readdir(from)){if(['node_modules','__pycache__'].includes(name))continue;await copy(join(from,name),join(to,name));}}else{const data=await bounded(from,64*1024*1024);await directory(dirname(to));try{await checked(to,'file');}catch(e){if(e.code!=='ENOENT')throw e;}await writeFile(to,data);}}
  await copy(join(root,'test'),join(view,'test'));await copy(join(root,'server/cloudflare'),join(view,'server/cloudflare'));await directory(join(view,'target/build/cloudflare/worker'));
  for(const name of ['index.js','index_bg.wasm'])await copy(join(work,'worker',name),join(view,'target/build/cloudflare/worker',name));
  return view;
}


// 完整流程的资源需求从本仓声明和两份锁读取；不复制控制台工具实现。
const productRoot = root;
async function flowDeclaration() {
  return structuredClone(contract);
}
function cargoPackages(text) {
  const result = [];
  for (const block of text.split('[[package]]').slice(1)) {
    const source = block.match(/^source = "([^"]+)"$/mu)?.[1];
    if (!source) continue;
    if (source !== 'registry+https://github.com/rust-lang/crates.io-index') fail('Cargo存在未实现的来源');
    const name = block.match(/^name = "([a-zA-Z0-9_-]+)"$/mu)?.[1];
    const version = block.match(/^version = "([0-9][a-zA-Z0-9.+-]*)"$/mu)?.[1];
    const sha256 = block.match(/^checksum = "([a-f0-9]{64})"$/mu)?.[1];
    if (!name || !version || !sha256) fail('Cargo锁坐标无效');
    result.push({name, version, sha256, url: 'https://static.crates.io/crates/' + name + '/' + name + '-' + version + '.crate'});
  }
  if (!result.length) fail('Cargo锁闭包为空');
  return result;
}
// npm依赖由锁中真实解析位置闭包决定，平台不适用的可选包不下载。
function npmPackages(lock, host, roots) {
  const [os, cpu] = host.split('-');
  const packages = lock.packages;
  if (lock.lockfileVersion !== 3 || !packages?.['']) fail('npm锁格式无效');
  const selected = new Set();
  function visit(path) {
    const entry = packages[path];
    if (!entry) fail('npm锁缺少解析条目：' + path);
    const matches = (values, value) => !values || (!values.includes('!' + value) && (values.every(v => v.startsWith('!')) || values.includes(value)));
    if (!matches(entry.os, os) || !matches(entry.cpu, cpu) || !matches(entry.libc, os === 'linux' ? 'glibc' : 'none')) return false;
    if (selected.has(path)) return true;
    selected.add(path);
    for (const [name, optional] of [...Object.keys(entry.dependencies ?? {}).map(n => [n, false]),
      ...Object.keys(entry.optionalDependencies ?? {}).map(n => [n, true])]) {
      let at = path, resolved;
      while (true) {
        const possible = (at ? at + '/' : '') + 'node_modules/' + name;
        if (packages[possible]) { resolved = possible; break; }
        if (!at) break;
        const marker = at.lastIndexOf('/node_modules/');
        at = marker >= 0 ? at.slice(0, marker) : '';
      }
      if (!resolved || !visit(resolved)) { if (!optional) fail('npm必要依赖缺失或宿主不符：' + name); }
    }
    return true;
  }
  for (const path of roots??Object.keys({...packages[''].dependencies,...packages[''].devDependencies}).map(name=>'node_modules/'+name)) {if(!packages[path])fail('npm构建根缺失');visit(path);}
  return [...selected].sort().map(path => {
    const p = packages[path];
    if (!/^https:\/\/registry\.npmjs\.org\/[a-zA-Z0-9@/_.+-]+\.tgz$/u.test(p.resolved ?? '') ||
      !/^sha512-[a-zA-Z0-9+/]+={0,2}$/u.test(p.integrity ?? '')) fail('npm固定原件来源无效');
    return {path, version: p.version, url: p.resolved, integrity: p.integrity};
  });
}
async function flowRequirements(flow, host = process.platform + '-' + process.arch) {
  if (!['build','test'].includes(flow) || !['linux-x64', 'darwin-arm64'].includes(host)) fail('流程资源身份无效');
  const d = await flowDeclaration();
  const ids = flow==='build'?['node','rust','protoc','worker-build','wasm-bindgen','wasm-opt']: ['node', 'git', 'bash', 'python', 'rust', 'protoc', 'worker-build', 'wasm-bindgen', 'wasm-opt'];
  const tools = ids.map(id => {
    const value = id === 'node' ? {version: d.resources.bootstrap.node_version, platforms: d.resources.bootstrap.platforms} : d.resources.tools[id];
    const archive = value?.platforms[host];
    if (!archive) fail('当前宿主缺少工具配方：' + id);
    return {id, version: value.version, archive,slots:id==='rust'?['bin/cargo','bin/rustc','bin/rustdoc',...(flow==='build'?[]:['bin/rustfmt','bin/cargo-fmt','bin/cargo-clippy','bin/clippy-driver'])]:[archive.executable],...(id==='rust'?{components:[{...d.resources.tools.rust.std.platforms[host],target:d.resources.tools.rust.std.target}]}:{})};
  });
  return {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', flow, host, tools,...(host==='darwin-arm64'?{apple:{version:d.resources.apple.version,source:d.resources.apple.source,names:['clang','ar','ranlib','xcrun']}}:{}),
    cargo: cargoPackages((await readFile(join(root, 'Cargo.lock'))).toString()),
    npm: npmPackages(JSON.parse(await readFile(join(root, 'test/worker/package-lock.json'))), host,flow==='build'?['node_modules/esbuild']:undefined)};
}
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || /[\x00-\x1f\x7f]/u.test(value) || value.startsWith('/') ||
    value.split('/').some(x => !x || x === '.' || x === '..')) fail('归档相对路径无效');
  return value;
}
// 只接受校验正确的tar，支持官方PAX长路径；链接只物化为归档内已验真常规文件。
function tarEntries(bytes) {
  const entries = new Map(); let at = 0, extended = {};
  const string = b => b.toString('utf8').split('\0')[0];
  const number = b => { const s = string(b).trim(); if (!/^[0-7]*$/u.test(s)) fail('tar数字字段无效'); return parseInt(s || '0', 8); };
  while (at + 512 <= bytes.length) {
    const h = bytes.subarray(at, at + 512); if (!h.some(x => x)) break;
    const checksum = [...h].reduce((sum, x, i) => sum + (i >= 148 && i < 156 ? 32 : x), 0);
    if (checksum !== number(h.subarray(148, 156))) fail('tar头校验失败');
    const size = number(h.subarray(124, 136)), type = string(h.subarray(156, 157));
    if (size > 1024 ** 3 || at + 512 + size > bytes.length) fail('tar条目超限');
    const data = bytes.subarray(at + 512, at + 512 + size);
    let name = string(h.subarray(0, 100)), prefix = string(h.subarray(345, 500));
    if (prefix) name = prefix + '/' + name;
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L' || type === 'K') {
      if (size > 1024 * 1024) fail('GNU长路径超限');
      extended[type === 'L' ? 'path' : 'linkpath'] = string(data); continue;
    }
    if (type === 'x' || type === 'g') {
      if (size > 1024 * 1024) fail('PAX超限');
      const values = {};
      for (let p = 0; p < data.length;) {
        const space = data.indexOf(32, p), length = Number(data.subarray(p, space).toString());
        if (space < p || !Number.isSafeInteger(length) || length < 4 || p + length > data.length) fail('PAX字段无效');
        const record = data.subarray(space + 1, p + length - 1).toString(), equal = record.indexOf('=');
        if (equal < 1) fail('PAX键无效'); values[record.slice(0, equal)] = record.slice(equal + 1); p += length;
      }
      if (type === 'x') extended = values;
      continue;
    }
    name = (extended.path ?? name).replace(/\/$/u, '');
    const target = extended.linkpath ?? string(h.subarray(157, 257)); extended = {};
    if (!name || name === '.') continue;
    name = safeRelative(name);
    if (entries.has(name)) fail('tar重复路径');
    if (!['', '0', '1', '2', '5'].includes(type)) fail('tar含特殊设备或未知类型');
    entries.set(name, {type, mode: number(h.subarray(100, 108)) & 0o777, data: Buffer.from(data), target});
  }
  return entries;
}
function zipEntries(zip) {
  let end = -1;
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 65557); p--) {
    if (zip.readUInt32LE(p) === 0x06054b50 && p + 22 + zip.readUInt16LE(p + 20) === zip.length) { end = p; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) fail('ZIP目录无效');
  const count = zip.readUInt16LE(end + 10), start = zip.readUInt32LE(end + 16);
  if (start + zip.readUInt32LE(end + 12) !== end || count > 65534) fail('ZIP目录越界');
  const entries = new Map(); let at = start;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== 0x02014b50) fail('ZIP条目损坏');
    const nameSize = zip.readUInt16LE(at + 28), extraSize = zip.readUInt16LE(at + 30), commentSize = zip.readUInt16LE(at + 32);
    const rawName = zip.subarray(at + 46, at + 46 + nameSize), name = rawName.toString('utf8').replace(/\/$/u, '');
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), offset = zip.readUInt32LE(at + 42);
    const size = zip.readUInt32LE(at + 24), packed = zip.readUInt32LE(at + 20), mode = zip.readUInt32LE(at + 38) >>> 16;
    if (flags & 1 || ![0, 8].includes(method) || size > 256 * 1024 ** 2 || offset + 30 > start ||
      zip.readUInt32LE(offset) !== 0x04034b50 || mode && ![0, 0x8000, 0x4000].includes(mode & 0xf000)) fail('ZIP类型无效');
    const begin = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    if (begin + packed > start || !zip.subarray(offset + 30, offset + 30 + nameSize).equals(rawName)) fail('ZIP本地头不符');
    const data = zip.subarray(begin, begin + packed);
    safeRelative(name); if (entries.has(name)) fail('ZIP重复路径');
    const output = method === 0 ? Buffer.from(data) : inflateRawSync(data, {maxOutputLength: 256 * 1024 ** 2});
    if (output.length !== size) fail('ZIP展开长度不符');
    entries.set(name, {type: rawName.at(-1) === 47 ? '5' : '0', mode: mode & 0o777, data: output});
    at += 46 + nameSize + extraSize + commentSize;
  }
  if (at !== end) fail('ZIP目录条数不符'); return entries;
}
function debData(bytes) {
  if (bytes.subarray(0, 8).toString() !== '!<arch>\n') fail('Deb原件格式无效');
  let at = 8, result;
  while (at + 60 <= bytes.length) {
    const h = bytes.subarray(at, at + 60), name = h.subarray(0, 16).toString().trim().replace(/\/$/u, '');
    const length = Number(h.subarray(48, 58).toString().trim());
    if (!Number.isSafeInteger(length) || length < 0 || at + 60 + length > bytes.length || h.subarray(58).toString() !== '\x60\n') fail('Deb成员无效');
    if (/^data\.tar\.(?:gz|xz|zst)$/u.test(name)) { if (result) fail('Deb数据重复'); result = {name, data: bytes.subarray(at + 60, at + 60 + length)}; }
    at += 60 + length + length % 2;
  }
  if (!result) fail('Deb数据缺失'); return result;
}
async function directory(path) {
  try { return await checked(path, 'directory'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await directory(dirname(path)); await mkdir(path, {mode: 0o700}); return checked(path, 'directory');
  }
}
async function materialize(entries, destination, prefix = '.') {
  await directory(destination);
  const selected = new Map();
  for (const [name, value] of entries) {
    if (prefix !== '.' && !name.startsWith(prefix + '/')) continue;
    const relative = prefix === '.' ? name : name.slice(prefix.length + 1);
    if (relative) selected.set(safeRelative(relative), value);
  }
  function data(name, chain = new Set()) {
    const entry = selected.get(name);
    if (!entry || chain.has(name) || chain.size > 32 || entry.type === '5') fail('归档链接目标无效');
    if (!['1', '2'].includes(entry.type)) return entry;
    chain.add(name);
    const target = entry.type === '1' ? (prefix === '.' ? entry.target : entry.target.replace(prefix + '/', '')) :
      resolve('/', dirname(name), entry.target).slice(1);
    if (entry.target.startsWith('/') || !selected.has(target)) fail('归档链接越界');
    return data(target, chain);
  }
  for (const [name, entry] of selected) {
    const path = join(destination, name);
    if (entry.type === '5') { await directory(path); continue; }
    const value = data(name);
    await directory(dirname(path));
    await writeFile(path, value.data, {flag: 'wx', mode: value.mode & 0o111 ? 0o555 : 0o444});
  }
  if (!selected.size) fail('归档根缺失');
  return destination;
}
// 不继承调用者PATH、代理、Rust包装器或npm配置；上游命令名仅解析当前任务已验真闭包。
function cleanEnvironment(work, tools, extra = {}) {
  const environment = {LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: join(work, 'home'), TMPDIR: join(work, 'tmp'),
    PATH: join(work, 'bin'), PRODUCT_WORK_DIR: work, PRODUCT_ROOT: root, PRODUCT_FLOW_RESOURCE_RECEIPT: join(work, 'resources.json'), PRODUCT_NODE_BIN: tools.node, PYTHON: tools.python,
    PRODUCT_GIT_BIN: tools.git, CARGO: tools.cargo, RUSTC: tools.rustc, RUSTDOC: tools.rustdoc, CARGO_HOME: join(work, 'cargo-home'),
    CARGO_TARGET_DIR: join(work, 'cargo-target'), CARGO_NET_OFFLINE: 'true', CARGO_INCREMENTAL: '0',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', WORKER_BUILD: tools['worker-build'],
    WASM_BINDGEN_BIN: tools['wasm-bindgen'], WASM_OPT_BIN: tools['wasm-opt'], ESBUILD_BIN: tools.esbuild,
    PROTOC: tools.protoc, PRODUCT_BASH_BIN: tools.bash, WRANGLER_SEND_METRICS: 'false'};
  for (const [key, value] of Object.entries(extra)) {
    if (Object.hasOwn(environment, key)) { if (value !== environment[key]) fail('基础工具环境漂移'); continue; }
    if (!['TATACHAT_RESOURCE_RECEIPT', 'TATACHATSDK_PROTOCOL_DIR', 'WORKER_TEST_RECEIPT',
      'OPENSSL_DIR', 'OPENSSL_STATIC', 'CC', 'CXX', 'AR', 'RANLIB', 'CONFIG_SHELL', 'SHELL',
      'CFLAGS', 'CPPFLAGS', 'LDFLAGS', 'SQLITE3_CFLAGS', 'SQLITE3_LIBS', 'GIT_CONFIG_NOSYSTEM',
      'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER', 'PYTHONPATH', 'LD_LIBRARY_PATH',
      'DEVELOPER_DIR','SDKROOT','CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER','PRODUCT_TEST_REPORT','PRODUCT_TEST_SCOPE'].includes(key)) fail('工具环境有未知字段');
    environment[key] = value;
  }
  return Object.fromEntries(Object.entries(environment).filter(([, v]) => v !== undefined));
}
async function runTool(path, args, {work, cwd = root, tools = {}, environment = {}, signal, capture = true, binary = false, timeout = 30 * 60 * 1000} = {}) {
  await checked(path, 'file'); await checked(cwd, 'directory'); await workDirectory(work);
  signal?.throwIfAborted();
  if (cwd !== root && cwd !== work && !inside(work, cwd) && cwd !== join(root, 'server/cloudflare')) fail('工具执行目录越界');
  return runProcess(path,args,{work,cwd,environment:cleanEnvironment(work,tools,environment),signal,capture,binary,timeout});
}
// 前置阶段不持有资源工作根，仍使用同一真实子进程取消与后代退出处理。
async function runProcess(path,args,{work,cwd=root,environment={},signal,capture=true,binary=false,timeout=30*60*1000}={}) {
  signal?.throwIfAborted();
  const child = spawn(path, args, {cwd, env: environment,
    detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  trackFixedProcess(work,child.pid);
  let stdout = '', stderr = '', failed = false, hard, processError, stopping = false;
  const tracker = child.pid ? descendantTracker(child.pid) : null;
  const ownedError = () => { failed = true; unsafeWork.add(work); };
  const terminate = kind => {
    if (!Number.isSafeInteger(child.pid)) return;
    try { process.kill(-child.pid, kind); } catch (e) { if (e.code !== 'ESRCH') ownedError(); }
  };
  const stop = () => {
    failed = true; if (stopping) return; stopping = true;
    terminate('SIGTERM');
    hard = setTimeout(() => { terminate('SIGKILL'); tracker?.stop().catch(ownedError); }, 5000);
  };
  const consume = (name, chunk) => {
    if (capture) {
      if (name === 'out') stdout += binary ? chunk.toString('binary') : chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > (binary ? 1024 ** 3 : 64 * 1024 ** 2)) stop();
    } else (name === 'out' ? process.stdout : process.stderr).write(chunk);
  };
  // 先登记输出和终态，再异步读取/proc；快速版本命令退出不能丢失close事件。
  child.stdout.on('data', b => consume('out', b)); child.stderr.on('data', b => consume('err', b));
  const completed = new Promise(ok => {
    child.once('error', () => { processError = true; });
    child.once('close', (code, terminalSignal) => ok({code, terminalSignal}));
  });
  const tracking = tracker ? setInterval(() => tracker.scan().catch(ownedError), 50) : null;
  tracker?.scan().catch(ownedError);
  const timer = setTimeout(stop, timeout); signal?.addEventListener('abort', stop, {once: true});
  if (signal?.aborted) stop();
  const result = await completed;
  clearTimeout(timer); clearTimeout(hard); clearInterval(tracking); signal?.removeEventListener('abort', stop);
  // Linux同时回读实际后代PID和启动坐标；进程组退出不能代替已识别后代退出。
  let quiet;
  try {
    quiet = !tracker || await tracker.quiet();
    if (!quiet) {
      await tracker.stop();
      for (let n = 0; n < 100 && !quiet; n++) { await delay(50); quiet = await tracker.quiet(); }
      failed = true;
    }
  } catch { quiet = false; }
  if (!quiet) { unsafeWork.add(work); fail('实际工具后代退出未确认'); }
  if (processError || failed || signal?.aborted || result.code !== 0 || result.terminalSignal) {
    fail('工具运行未完整成功：' + basename(path));
  }
  return {stdout, stderr};
}
async function treeManifest(path) {
  const files = [];
  async function walk(at, relative = '') {
    for (const name of (await readdir(at)).sort()) {
      const full = join(at, name), rel = relative + name, st = await lstat(full);
      if (st.isDirectory()) { await checked(full, 'directory'); await walk(full, rel + '/'); }
      else { const bytes = await bounded(full, 1024 ** 3); files.push({path: rel, sha256: digest(bytes), bytes: bytes.length, mode: st.mode & 0o777}); }
    }
  }
  await walk(path); return files;
}
// 独立原件可存于本轮已领取的准确固定根；边界检查先于建目录，不能污染源码或另一工作根。
async function originalStore(store, work) {
  if (typeof store !== 'string' || resolve(store) !== store) fail('原件存储路径无效');
  if (store === root || inside(root, store)) {
    try { checkFixedWork(work); } catch { fail('原件存储必须位于源码外或本轮工作根内'); }
    if (!inside(work, store)) fail('原件存储必须位于源码外或本轮工作根内');
    const owner = JSON.parse(await bounded(join(work, '.active.json'), 65536));
    if (owner.schema !== 1 || owner.product_id !== 'citizenserve' || owner.work !== work || owner.state !== 'running'
        || !Number.isSafeInteger(owner.pid) || owner.pid < 1) fail('临时原件缺少本轮工作根所有权');
    try { process.kill(owner.pid, 0); } catch { fail('临时原件所属进程已退出'); }
  }
  await directory(store);
  return store;
}

async function original(entry, options, kind) {
  const maximum = 1024 ** 3;
  if (options.mode === 'console') {
    if (typeof options.acquireOriginal !== 'function') fail('控制台未交付公开原件获取能力');
    const path = await options.acquireOriginal(entry, {kind, signal: options.signal, offline: options.offline});
    const base = kind === 'tool' ? options.toolRoot : options.dependencyRoot;
    await checked(base, 'directory');
    if (!inside(base, path)) fail('控制台原件越界');
    const bytes = await bounded(path, maximum); return {path, bytes};
  }
  const store = kind === 'tool' ? options.toolRoot : options.dependencyRoot;
  options.signal?.throwIfAborted();
  await originalStore(store, options.work);
  const key = entry.sha256 ?? digest(Buffer.from(entry.integrity ?? ''));
  const path = join(store, key + '.blob');
  try { const bytes = await bounded(path, maximum); return {path, bytes}; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (options.offline) fail('离线缺少锁定原件');
  const initial = new URL(entry.url);
  if (initial.protocol !== 'https:' || initial.username || initial.password || initial.hash) fail('原件来源无效');
  const allowed = new Set([initial.hostname, 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  let url = initial.href, response;
  const requestSignal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
  for (let n = 0; n < 6; n++) {
    response = await (options.fetcher ?? fetch)(url, {signal: requestSignal, credentials: 'omit', redirect: 'manual'});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = new URL(response.headers.get('location'), url); await response.body?.cancel();
    if (n === 5 || next.protocol !== 'https:' || next.username || next.password || !allowed.has(next.hostname)) fail('原件重定向越界');
    url = next.href;
  }
  if (!response?.ok || !response.body) fail('锁定原件获取失败');
  const chunks = []; let size = 0;
  for await (const b of response.body) { requestSignal.throwIfAborted(); size += b.length; if (size > maximum) fail('原件超限'); chunks.push(Buffer.from(b)); }
  const bytes = Buffer.concat(chunks);
  const pending = join(store, '.' + randomUUID() + '.pending');
  try {
    await writeFile(pending, bytes, {flag: 'wx', mode: 0o444}); options.signal?.throwIfAborted();
    try { await link(pending, path); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  } finally { await rm(pending, {force: true}); }
  const saved = await bounded(path, maximum); return {path, bytes: saved};
}

async function unpack(bytes, kind, options, tools) {
  if (kind === 'deb') {
    const value = debData(bytes);
    return unpack(value.data, value.name.endsWith('.zst') ? 'tar-zstd' : value.name.endsWith('.xz') ? 'tar-xz' : 'tar-gzip', options, tools);
  }
  if (kind === 'zip' || kind === 'extract' && bytes.readUInt32LE(0) === 0x04034b50) return zipEntries(bytes);
  if (kind === 'tar-xz' || bytes.subarray(0, 6).equals(Buffer.from([253, 55, 122, 88, 90, 0]))) {
    if (!tools.busybox) return tarEntries(await xzBytes(bytes,options.signal));
    const source = join(options.work, 'unpack-' + randomUUID() + '.xz');
    await writeFile(source, bytes, {flag: 'wx', mode: 0o400});
    try {
      // xz只处理已验真归档；输出经Node逐条校验，不调用系统tar。
      const {stdout} = await runTool(tools.busybox, ['xz', '-dc', source], {...options, tools, binary: true});
      return tarEntries(Buffer.from(stdout, 'binary'));
    } finally { if (!unsafeWork.has(options.work)) await rm(source, {force: true}); }
  }
  const tar = kind === 'tar-zstd' ? zstdDecompressSync(bytes, {maxOutputLength: 1024 ** 3}) :
    bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes, {maxOutputLength: 1024 ** 3}) : bytes;
  return tarEntries(tar);
}
async function mutableTree(path) {
  for (const name of await readdir(path)) {
    const full = join(path, name), st = await lstat(full);
    if (st.isDirectory()) await mutableTree(full);
    else await chmod(full, st.mode & 0o111 ? 0o700 : 0o600);
  }
}
async function binaryFile(bytes, path) {
  await directory(dirname(path)); await writeFile(path, bytes, {flag: 'wx', mode: 0o555}); return path;
}
async function closeCommands(work, tools) {
  const bin = await directory(join(work, 'bin'));
  for (const [name, value] of Object.entries(tools)) {
    if (!value || name === 'busybox' || name === 'sh' || name.endsWith('Prefix') || !/^[a-zA-Z0-9_-]+$/u.test(name)) continue;
    const destination = join(bin, name);
    try { await lstat(destination); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      await checked(value, 'file');
      await binaryFile(Buffer.from('#!'+tools.node+'\n'+"const {spawnSync}=require('node:child_process');const child=spawnSync("+JSON.stringify(value)+",process.argv.slice(2),{argv0:"+JSON.stringify(name)+",stdio:'inherit',env:process.env});if(child.error||child.signal)process.exit(1);process.exit(child.status??1);\n"),destination);
    }
  }
}
async function installRust(entries, archive, prefix) {
  const componentFile = entries.get(archive.root + '/components');
  if (!componentFile) fail('Rust组件清单缺失');
  const permitted = new Set(['rustc', 'cargo', 'rustfmt-preview', 'clippy-preview',
    'rust-std-x86_64-unknown-linux-gnu', 'rust-std-aarch64-apple-darwin', 'rust-std-wasm32-unknown-unknown']);
  const components = componentFile.data.toString().trim().split('\n').filter(c => permitted.has(c));
  if (!components.length) fail('Rust必要组件缺失');
  for (const component of components) {
    const marker = archive.root + '/' + component + '/';
    const files = new Map([...entries].filter(([name]) => name.startsWith(marker) && name !== marker + 'manifest.in')
      .map(([name, value]) => [name.slice(marker.length), value]));
    // 同版本公共许可证可重复；二进制或库重名必须逐字相同。
    const pending = join(prefix, '.component-' + randomUUID()); await materialize(files, pending);
    for (const file of await treeManifest(pending)) {
      const path = join(prefix, file.path); await directory(dirname(path));
      const bytes = await readFile(join(pending, file.path));
      try { if (!(await readFile(await checked(path, 'file'))).equals(bytes)) fail('Rust组件重名漂移'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; await binaryFile(bytes, path); await chmod(path, file.mode); }
    }
    await rm(pending, {recursive: true, force: true});
  }
}
async function nativeLinux(id, archive, options, tools, d) {
  const source = join(options.work, 'prepare', id, 'source'), prefix = join(options.work, 'prepare', id, 'payload');
  await directory(dirname(source)); await directory(prefix);
  const entry = await original(archive, options, 'tool');
  await materialize(await unpack(entry.bytes, archive.kind, options, tools), source, archive.root);
  await mutableTree(source);
  const common = {work: options.work, cwd: source, tools, signal: options.signal,
    environment: {CC: join(options.work, 'bin/cc'), CXX: join(options.work, 'bin/c++'),
      AR: join(options.work, 'bin/ar'), RANLIB: join(options.work, 'bin/ranlib'),
      CONFIG_SHELL: tools.sh, SHELL: tools.sh}};
  const make = (args = [], environment = {}) => runTool(tools.make, ['-j2', 'SHELL=' + tools.sh, ...args],
    {...common, environment: {...common.environment, ...environment}});
  const configure = args => runTool(tools.sh, [join(source, 'configure'), '--prefix=' + prefix, ...args], common);
  if (id === 'bash') {
    for (const patch of d.resources.tools.bash.patches) {
      const file = await original(patch, options, 'tool');
      await applyBashPatch(source, file.bytes);
    }
    await configure(['--disable-nls', '--without-bash-malloc', '--disable-readline']);
    await make(); await make(['install']);
  } else if (id === 'zlib') {
    await configure(['--static']); await make(); await make(['install']);
  } else if (id === 'perl') {
    await runTool(tools.sh, [join(source, 'Configure'), '-des', '-Dprefix=' + prefix,
      '-Dcc=' + join(options.work, 'bin/cc'), '-Dar=' + join(options.work, 'bin/ar'),
      '-Dranlib=' + join(options.work, 'bin/ranlib'), '-Duseshrplib=false'], common);
    await make(); await make(['install']);
  } else if (id === 'openssl') {
    await runTool(tools.perl, [join(source, 'Configure'), 'linux-x86_64', 'no-shared', 'no-tests',
      '--prefix=' + prefix, '--libdir=lib', '--openssldir=' + join(prefix, 'ssl')], common);
    await make(); await make(['install_sw']);
  } else if (id === 'python') {
    const sqliteArchive = d.resources.preparation['linux-x64'].sqlite;
    const sqlite = await original(sqliteArchive, options, 'tool');
    const sql = join(options.work, 'prepare/sqlite');
    await materialize(await unpack(sqlite.bytes, 'zip', options, tools), sql, sqliteArchive.root);
    const object = join(options.work, 'prepare/sqlite3.o'), library = join(options.work, 'prepare/libsqlite3.a');
    await runTool(join(options.work, 'bin/cc'), ['-O2', '-fPIC', '-DSQLITE_ENABLE_JSON1', '-DSQLITE_ENABLE_FTS5',
      '-DSQLITE_THREADSAFE=1', '-c', join(sql, 'sqlite3.c'), '-o', object], common);
    await runTool(join(options.work, 'bin/ar'), ['rcs', library, object], common);
    common.environment.SQLITE3_CFLAGS = '-I' + sql;
    common.environment.SQLITE3_LIBS = library + ' -lm -ldl -lpthread';
    common.environment.CPPFLAGS = '-I' + join(tools.zlibPrefix, 'include');
    common.environment.LDFLAGS = '-L' + join(tools.zlibPrefix, 'lib');
    await configure(['--without-ensurepip', '--disable-test-modules', '--with-openssl=' + tools.opensslPrefix]);
    await make(); await make(['install']);
  } else if (id === 'git') {
    const flags = ['prefix=' + prefix, 'NO_CURL=YesPlease', 'NO_OPENSSL=YesPlease', 'NO_GETTEXT=YesPlease',
      'NO_TCLTK=YesPlease', 'NO_PERL=YesPlease', 'NO_PYTHON=YesPlease', 'NO_EXPAT=YesPlease',
      'ZLIB_PATH=' + tools.zlibPrefix, 'CC=' + join(options.work, 'bin/cc'), 'AR=' + join(options.work, 'bin/ar')];
    // 流程只读提交对象；HTTPS操作由Node实现，不准备未调用的Git网络插件。
    await make([...flags, 'git']);
    await binaryFile(await readFile(join(source, 'git')), join(prefix, 'bin/git'));
  } else fail('未知原生工具配方');
  await normalizeLinks(prefix);
  // 原生准备命令及其已识别后代退出后，立即删除不再消费的可写源构建现场。
  if (unsafeWork.has(options.work)) fail('原生准备进程退出未确认');
  await rm(source, {recursive: true});
  return {prefix, path: join(prefix, archive.executable)};
}
async function cargoView(packages, destination, options, tools) {
  await directory(destination);
  for (const entry of packages) {
    const target = join(destination, entry.name + '-' + entry.version);
    try { await checked(target, 'directory'); continue; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const resource = await original(entry, options, 'dependency');
    await materialize(await unpack(resource.bytes, 'tar-gzip', options, tools), target, entry.name + '-' + entry.version);
    const files = Object.fromEntries((await treeManifest(target)).filter(f => f.path !== '.cargo-checksum.json').map(f => [f.path, f.sha256]));
    await writeFile(join(target, '.cargo-checksum.json'), JSON.stringify({files, package: entry.sha256}) + '\n', {mode: 0o444});
  }
}
async function npmView(packages, work, options, tools, flow) {
  const modules = join(work, 'worker-smoke/test/worker/node_modules');
  await directory(modules);
  for (const entry of packages) {
    const resource = await original(entry, options, 'dependency');
    const path = join(work, 'worker-smoke/test/worker', entry.path);
    await materialize(await unpack(resource.bytes, 'tar-gzip', options, tools), path, 'package');
    const value = JSON.parse(await readFile(join(path, 'package.json')));
  }
  const host = process.platform + '-' + process.arch;
  const packageName = host === 'linux-x64' ? '@esbuild/linux-x64' : '@esbuild/darwin-arm64';
  const esbuild = join(modules, packageName, 'bin/esbuild');
  const workerd = join(modules, host === 'linux-x64' ? '@cloudflare/workerd-linux-64' : '@cloudflare/workerd-darwin-arm64', 'bin/workerd');
  // 替代上游postinstall的唯一必要字节物化；不执行npm生命周期脚本。
  await rm(join(modules, 'esbuild/bin/esbuild'), {force: true});
  await binaryFile(await bounded(esbuild, 64 * 1024 ** 2), join(modules, 'esbuild/bin/esbuild'));
  if(flow!=='build'){await rm(join(modules,'workerd/bin/workerd'),{force:true});await binaryFile(await bounded(workerd,128*1024**2),join(modules,'workerd/bin/workerd'));}
  const receipt = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', flow, work, modules,
};
  const path = join(work, 'worker-receipt.json'), bytes = Buffer.from(JSON.stringify(receipt) + '\n');
  await writeFile(path, bytes, {flag: 'wx', mode: 0o444});
  return {path, esbuild};
}
async function prepareFlowResources(options) {
  options={...options};
  if(options.mode==='independent'){const {homedir}=await import('node:os'),base=join(homedir(),'.local/share/product-resources');options.toolRoot??=join(base,'tools/archives');options.dependencyRoot??=join(base,'rely/objects');}
  const {flow, work, mode, signal} = options;
  await workDirectory(work);
  if (!['independent', 'console'].includes(mode)) fail('资源模式必须明确');
  const requested = await flowRequirements(flow);
  const d = await flowDeclaration(), tools = {};
  for (const name of ['home', 'tmp']) await directory(join(work, name));
  if (requested.host === 'linux-x64' && process.report.getReport().header.glibcVersionRuntime !== '2.39') fail('Linux引导要求实际Ubuntu24.04的glibc2.39');
  if (requested.host === 'darwin-arm64') {
    const supply={schema:1,product_id:'citizenserve',flow,work,tools:{}};
    const policy={...options,acquireTool:null,acquireApple:null};
    const acquireTool=mode==='console'?options.acquireTool:(wanted=>independentTool(wanted,policy));
    const acquireApple=mode==='console'?options.acquireApple:(wanted=>macApple(work,wanted,signal));
    if(typeof acquireTool!=='function'||typeof acquireApple!=='function')fail('当前任务未交付公开工具或Apple能力');
    policy.acquireTool=acquireTool;policy.acquireApple=acquireApple;
    for(const item of requested.tools){
      signal?.throwIfAborted();const supplied=await acquireTool(item);supply.tools[item.id]=supplied;tools[item.id]=supplied.path;
      for(const [slot,path] of Object.entries(supplied.slots))if(item.slots.includes(slot))tools[basename(slot)]=await realpath(path);
    }
    options.supply=supply;
    tools.node=process.execPath;
    const delivered=await acquireApple(requested.apple);
    options.apple=delivered;Object.assign(tools,delivered.tools);await closeCommands(work,tools);
  } else {
    const bootstrap = await original(d.resources.bootstrap.platforms[requested.host], options, 'tool');
    const entries = await unpack(bootstrap.bytes, 'tar-gzip', options, tools);
    const nodeBytes = entries.get(d.resources.bootstrap.platforms[requested.host].root + '/bin/node')?.data;
    tools.node = process.execPath;
    const helpers = d.resources.preparation[requested.host];
    for (const id of ['busybox', 'make']) {
      const value = await original(helpers[id], options, 'tool');
      const at = join(work, 'prepare', id);
      await materialize(await unpack(value.bytes, 'deb', options, tools), at);
      tools[id] = join(at, helpers[id].executable);
    }
    // 引导闭包是固定BusyBox的实际appet，不读取系统PATH。
    const applets = ['sh', 'awk', 'grep', 'sed', 'cat', 'chmod', 'chown', 'cp', 'cut', 'date', 'dirname', 'echo',
      'env', 'expr', 'find', 'head', 'id', 'install', 'ln', 'ls', 'mkdir', 'mv', 'od', 'printf', 'pwd',
      'readlink', 'rm', 'rmdir', 'sort', 'tail', 'tee', 'test', 'touch', 'tr', 'uname', 'uniq', 'wc', 'xargs', 'which'];
    for (const id of applets) tools[id] = await binaryFile(await readFile(tools.busybox), join(work, 'bin', id));
    const zig = await original(helpers.zig, options, 'tool');
    const zigRoot = join(work, 'prepare/zig');
    await materialize(await unpack(zig.bytes, 'tar-xz', options, tools), zigRoot, helpers.zig.root);
    tools.zig = join(zigRoot, 'zig');
    for (const [name, args] of [['cc', 'cc -target x86_64-linux-gnu.2.39'], ['c++', 'c++ -target x86_64-linux-gnu.2.39'], ['ar', 'ar'], ['ranlib', 'ranlib']]) {
      await binaryFile(Buffer.from('#!' + tools.sh + '\nexec ' + shellQuote(tools.zig) + ' ' + args + ' "$@"\n'), join(work, 'bin', name));
    }
    const z = await nativeLinux('zlib', helpers.zlib, options, tools, d); tools.zlibPrefix = z.prefix;
    for (const id of ['git','bash','perl','openssl','python']) {
      const toolArchive = d.resources.tools[id].platforms[requested.host];
      const value = await nativeLinux(id, toolArchive, options, tools, d);
      tools[id] = value.path;
      if (id === 'openssl') tools.opensslPrefix = value.prefix;
      await closeCommands(work, {node:tools.node,sh: tools.sh, [id]: value.path});
    }
    for (const tool of requested.tools.filter(x => !['node', 'git', 'bash', 'python', 'worker-build'].includes(x.id))) {
      const file = await original(tool.archive, options, 'tool'), prefix = join(work, 'prepare', tool.id, 'payload');
      const values = await unpack(file.bytes, tool.archive.kind, options, tools);
      if (tool.id === 'rust') {
        await installRust(values, tool.archive, prefix);
        for (const component of d.resources.tools.rust.components) {
          const item = await original(component, options, 'tool');
          await installRust(await unpack(item.bytes, component.kind, options, tools), component, prefix);
        }
        const std = d.resources.tools.rust.std.platforms[requested.host], stdBytes = await original(std, options, 'tool');
        await installRust(await unpack(stdBytes.bytes, std.kind, options, tools), std, prefix);
        Object.assign(tools, Object.fromEntries(['cargo', 'rustc', 'rustdoc', 'rustfmt', 'cargo-fmt', 'cargo-clippy', 'clippy-driver'].map(id => [id, join(prefix, 'bin', id)])));
      } else {
        await materialize(values, prefix, tool.archive.root); tools[tool.id] = join(prefix, tool.archive.executable);
      }
    }
    await closeCommands(work, tools);
  }
  for (const name of ['home', 'tmp', 'cargo-home', 'cargo-target', 'bin', 'prepare']) await directory(join(work, name));
  let protocol, npm;
  {
    const vendor = join(work, 'cargo-vendor');
    const all = new Map();
    for (const item of [...requested.cargo, ...(requested.host==='linux-x64'?d.resources.worker_build_packages:[]).map(p => ({...p, url: 'https://static.crates.io/crates/' + p.name + '/' + p.name + '-' + p.version + '.crate'}))]) {
      const key = item.name + '-' + item.version;
      if (all.has(key) && all.get(key).sha256 !== item.sha256) fail('Cargo同坐标原件摘要冲突');
      all.set(key, item);
    }
    await cargoView([...all.values()], vendor, options, tools);
    const config = '[source.crates-io]\nreplace-with = "locked"\n[source.locked]\ndirectory = ' + JSON.stringify(vendor) + '\n[net]\noffline = true\n';
    await writeFile(join(work, 'cargo-home/config.toml'), config, {flag: 'wx', mode: 0o444});
    if (requested.host === 'linux-x64') {
      const item = d.resources.tools['worker-build'], file = await original(item.platforms[requested.host], options, 'tool');
      const source = join(work, 'prepare/worker-build/source'), prefix = join(work, 'prepare/worker-build/payload');
      await materialize(await unpack(file.bytes, 'tar-gzip', options, tools), source, item.platforms[requested.host].root);
      
      await runTool(tools.cargo, ['install', '--path', source, '--locked', '--offline', '--root', prefix],
        {work, tools, signal, environment: {CC: join(work, 'bin/cc'), AR: join(work, 'bin/ar'), OPENSSL_DIR: tools.opensslPrefix,
          OPENSSL_STATIC: '1', CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: join(work, 'bin/cc')}});
      if (unsafeWork.has(work)) fail('worker-build准备进程退出未确认');
      await rm(source, {recursive: true}); await normalizeLinks(prefix);
      tools['worker-build'] = join(prefix, 'bin/worker-build'); await closeCommands(work, {node:tools.node,sh: tools.sh, 'worker-build': tools['worker-build']});
    }
    npm = await npmView(requested.npm, work, options, tools, flow); tools.esbuild = npm.esbuild;
    await closeCommands(work,tools);
    // 协议仍使用build.rs消费的唯一回执；控制台原件交由公开能力获取。
    const requestedProtocol = await protocolRequirements();
    if (mode === 'console') {
      const p = {}, a = await original(requestedProtocol.tools[0].archive, options, 'tool');
      if(!localSdkMode())for (const item of requestedProtocol.archives) p[item.name] = (await original(item, options, 'dependency')).path;
      protocol = await prepare({work, mode, signal, supply: {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', work,
        dependency_root: options.dependencyRoot, tool_root: options.toolRoot, protoc_archive: a.path, protoc: tools.protoc, protocol: p}});
    } else protocol = await prepare({work, mode, store: options.dependencyRoot, toolStore: options.toolRoot, offline: options.offline, signal, fetcher: options.fetcher ?? fetch});
    // build.rs逐字核对协议回执中的实际入口，不能传入准备前的工具库坐标。
    tools.protoc=protocol.protoc;
  }
  const environment = cleanEnvironment(work, tools, {...(protocol ? {TATACHAT_RESOURCE_RECEIPT: join(work, 'tatachat-protocol/receipt.json'), TATACHATSDK_PROTOCOL_DIR: protocol.protocol} : {}),
    ...(npm ? {WORKER_TEST_RECEIPT: npm.path} : {}),
    ...(options.apple?{CC:tools.clang,AR:tools.ar,RANLIB:tools.ranlib,DEVELOPER_DIR:options.apple.developerDirectory,SDKROOT:options.apple.sdk,CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER:tools.clang}:{}),
    ...(tools.opensslPrefix ? {OPENSSL_DIR: tools.opensslPrefix, OPENSSL_STATIC: '1', CC: join(work, 'bin/cc'), AR: join(work, 'bin/ar'),
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: join(work, 'bin/cc')} : {})});
  const receipt = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', flow, work, mode,...(options.runID?{run_id:options.runID}:{}),apple:options.apple??null,
    tools, environment};
  const path = join(work, 'resources.json');
  await writeFile(path, JSON.stringify(receipt) + '\n', {flag: 'wx', mode: 0o444});
  return receipt;
}
// 两类入口共用短锁，并检查全部长期守卫；任何活跃任务均阻止新领取和清场。
async function assertWorkUnclaimed(work) {
  for (const name of ['.active.json', '.product-build.lock']) {
    try { await lstat(join(work, name)); fail('固定现场仍有活跃任务，禁止清空'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
// 首个文件步骤声明同身份独占；短锁只用于检查、清空与登记，不覆盖活跃任务。
async function claimWork(flow,runID){
 if(!['build','test'].includes(flow)||!/^[a-zA-Z0-9_-]{1,96}$/.test(runID??''))fail('任务坐标无效');
 const session=claimFixedWork(flow==='test'?'test':'build/cloudflare');
 const work=session.owner.work;
 return {work,runID,flow,async finish(){assertWorkQuiescent(work);releaseFixedWork(session);}};
}

function assertWorkQuiescent(work) {
  if (unsafeWork.has(work)) fail('实际后代退出未确认，禁止清场');
}
function requireSuccessCount(result, label) {
  if (!result || Object.keys(result).sort().join(',') !== 'cancelled,failed,passed,skipped,todo' || !Number.isSafeInteger(result.passed) || result.passed < 1 ||
    ['failed', 'skipped', 'todo', 'cancelled'].some(k => result[k] !== 0)) fail(label + '没有完整执行成功');
  return result;
}
async function compileWorker(receipt, signal) {
  await workDirectory(receipt.work);
  const {work, tools} = receipt;
  for (const id of ['cargo', 'rustc', 'worker-build', 'wasm-bindgen', 'wasm-opt', 'esbuild']) await checked(tools[id], 'file');
  const output = join(work, 'worker'); await directory(output);
  const buildLog=await runTool(tools['worker-build'], ['--out-dir', output, '--release', '--', '--locked', '--offline'], {
    work, cwd: join(root, 'server/cloudflare'), tools, environment: receipt.environment, signal});
  process.stderr.write(buildLog.stdout+buildLog.stderr);
  for (const name of ['index.js', 'index_bg.wasm']) {
    const bytes = await bounded(join(output, name), 128 * 1024 ** 2);
    if (!bytes.length || name.endsWith('.wasm') && !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) fail('Worker真实产物无效');
  }
  return output;
}
// 生命周期先使用真实固定根，退出收尾后才能领取完整检查的资源现场。
const lifecycleReceipts = new WeakMap();
function productTestSources(){return {lifecycle:['scripts/build.mjs'],contracts:['scripts/build.mjs','scripts/tatachat.mjs']};}
function checkSources(value=productTestSources()){
 if(!value||value.lifecycle?.join(',')!=='scripts/build.mjs'||value.contracts?.join(',')!=='scripts/build.mjs,scripts/tatachat.mjs')fail('产品测试来源登记不完整');
 return {lifecycle:[...value.lifecycle],contracts:[...value.contracts]};
}
function tapCounts(output) {
  const result = {};
  for (const [field,label] of Object.entries({passed:'pass',failed:'fail',skipped:'skipped',todo:'todo',cancelled:'cancelled'})) {
    const matches = [...output.matchAll(new RegExp('^# '+label+' ([0-9]+)$','gm'))];
    if (matches.length !== 1) fail('生命周期测试终态统计缺失或重复');
    result[field] = Number(matches[0][1]);
  }
  const tests = [...output.matchAll(/^# tests ([0-9]+)$/gm)];
  if (tests.length !== 1 || Number(tests[0][1]) !== Object.values(result).reduce((a,b)=>a+b,0)) fail('生命周期测试总数不符');
  return requireSuccessCount(result,'生命周期测试');
}
async function lifecycleChecks(signal) {
  signal?.throwIfAborted();
  const sources=checkSources();
  for (const scope of ['build','test']) {
    try { const work=fixedWork(scope); await checked(work,'directory'); await assertWorkUnclaimed(work); }
    catch(error) { if(error.code!=='ENOENT')throw error; }
  }
  const run=randomUUID();let quiet=true;
  try {
    const result=await runProcess(process.execPath,
      ['--test','--test-concurrency=1','--test-reporter=tap',...sources.lifecycle],
      {cwd:root,environment:{PATH:dirname(process.execPath),LANG:'C.UTF-8',LC_ALL:'C.UTF-8',PRODUCT_LIFECYCLE_RUN:run,PRODUCT_TEST_SCOPE:'lifecycle'},signal});
    process.stderr.write(result.stdout+result.stderr);
    return Object.freeze({sources:Object.freeze(sources.lifecycle),counts:Object.freeze(tapCounts(result.stdout))});
  } catch(error) {
    quiet=!String(error.message).includes('退出未确认');throw error;
  } finally {
    // 只清理同一次前置运行的已退出现场；未知后代或其他任务的所有权保持。
    if(quiet)for(const scope of ['build/cloudflare','test'])finishLifecycleWork(scope,run);
  }
}
async function checkStages(options,operation,signal,stages) {
  if(!options||!['build','test'].includes(options.flow)||!['independent','console'].includes(options.mode)||
      options.work!==fixedWork(options.flow==='test'?'test':'build')||
      !/^[a-zA-Z0-9_-]{1,96}$/u.test(options.runID??'')||typeof operation!=='function')fail('完整检查配置或固定现场无效');
  const lifecycle=await stages.lifecycle(signal);
  requireSuccessCount(lifecycle.counts,'生命周期测试');signal?.throwIfAborted();
  const task=await stages.claim(options.flow,options.runID);
  let receipt;
  try {
    if(task.work!==options.work)fail('完整检查领取根与配置不符');signal?.throwIfAborted();
    receipt=await stages.prepare({...options,work:task.work,signal});
    lifecycleReceipts.set(receipt,lifecycle);
    return await operation(receipt);
  } finally { if(receipt)lifecycleReceipts.delete(receipt);await task.finish(); }
}
async function withProductTests(options,operation,signal) {
  return checkStages(options,operation,signal,{lifecycle:lifecycleChecks,claim:claimWork,prepare:prepareFlowResources});
}
async function executeProductTests(options,signal) {
  return withProductTests(options,receipt=>productTests(receipt,signal),signal);
}
function requireLifecycle(receipt) {
  const value=lifecycleReceipts.get(receipt);
  if(!value)fail('完整检查缺少本次实际前置生命周期结果');
  lifecycleReceipts.delete(receipt);return value;
}
function validateAcceptance(value) {
  if(value?.schema!==2||value.product_id!=='citizenserve'||value.platform!=='cloudflare')fail('产品测试身份或版本无效');
  for(const key of ['lifecycle','contracts','node','rust','python','worker'])requireSuccessCount(value[key],key);
  if(!['passed','failed','skipped','todo','cancelled'].every(key=>value.node[key]===value.lifecycle[key]+value.contracts[key]))fail('Node验收计数缺失或重复');
  const sources=checkSources();
  if(!Array.isArray(value.lifecycle_sources)||value.lifecycle_sources.join(',')!==sources.lifecycle.join(',')||
      !Array.isArray(value.node_sources)||value.node_sources.join(',')!==sources.contracts.join(',')||
      !Array.isArray(value.worker_sources)||value.worker_sources.join(',')!=='push_crypto.mjs,worker_smoke.mjs,tatachat_smoke.mjs,tatachat_data_smoke.mjs')fail('完整自动化实际检查缺项或顺序错误');
  return value;
}

async function productTests(receipt, signal) {
  const lifecycle = requireLifecycle(receipt);
  await workDirectory(receipt.work);
  const {work, tools} = receipt;
  async function run(id, args, extra = {}) {
    const value = await runTool(tools[id], args, {work, tools, environment: receipt.environment, signal, ...extra});
    process.stderr.write(value.stdout+value.stderr);
    return value;
  }
  await run('cargo', ['fmt', '--all', '--', '--check']);
  const rust = await run('cargo', ['test', '-p', 'citizenserve', '--all-targets', '--locked', '--offline']);
  const results = [...(rust.stdout + rust.stderr).matchAll(/test result: ok\. ([0-9]+) passed; ([0-9]+) failed; ([0-9]+) ignored;/gu)];
  const rustCount = requireSuccessCount({passed: results.reduce((n, m) => n + Number(m[1]), 0),
    failed: results.reduce((n, m) => n + Number(m[2]), 0), skipped: results.reduce((n, m) => n + Number(m[3]), 0), todo: 0, cancelled: 0}, 'Rust测试');
  await run('cargo', ['clippy', '-p', 'citizenserve', '--all-targets', '--locked', '--offline', '--', '-D', 'warnings']);
  const python = await run('python', ['-c', [
    'import unittest,json,sys',
    's=unittest.defaultTestLoader.discover("test",pattern="*storage_contract.py")',
    'n=s.countTestCases()',
    'r=unittest.TextTestRunner(verbosity=2).run(s)',
    'v={"passed":r.testsRun-len(r.failures)-len(r.errors)-len(r.skipped),"failed":len(r.failures)+len(r.errors),"skipped":len(r.skipped),"todo":0,"cancelled":0}',
    'print("CITIZENSERVE_TEST_COUNTS="+json.dumps(v))',
    'sys.exit(0 if n>0 and r.testsRun==n and r.wasSuccessful() and not r.skipped else 1)',
  ].join('\n')]);
  const counts = python.stdout.match(/^CITIZENSERVE_TEST_COUNTS=(\{.*\})$/mu);
  const pythonCount = requireSuccessCount(counts ? JSON.parse(counts[1]) : null, 'SQLite测试');
  await run('cargo', ['clippy', '-p', 'citizenserve-cloudflare', '--target', 'wasm32-unknown-unknown', '--locked', '--offline', '--', '-D', 'warnings']);
  await run('cargo', ['build', '-p', 'citizenserve-cloudflare', '--target', 'wasm32-unknown-unknown', '--release', '--locked', '--offline']);
  const nodeSources = checkSources().contracts;
  const nodeResult=await run('node', ['--test', '--test-concurrency=1', '--test-reporter=tap', ...nodeSources], {environment:{...receipt.environment,PRODUCT_TEST_SCOPE:'contracts'}});
  const nodeCount=tapCounts(nodeResult.stdout);
  await compileWorker(receipt, signal);
  const view = await workerTestView(receipt.environment.WORKER_TEST_RECEIPT, work);
  const workerResult=await run('node', ['--test', '--test-reporter=tap',
    'push_crypto.mjs', 'worker_smoke.mjs', 'tatachat_smoke.mjs', 'tatachat_data_smoke.mjs'], {cwd: join(view, 'test/worker'), environment:receipt.environment});
  const workerCount=tapCounts(workerResult.stdout);
  const totalNode=Object.fromEntries(Object.keys(nodeCount).map(key=>[key,nodeCount[key]+lifecycle.counts[key]]));
  return validateAcceptance({schema:2,product_id:'citizenserve',platform:'cloudflare',lifecycle:lifecycle.counts,contracts:nodeCount,lifecycle_sources:[...lifecycle.sources],
    rust:rustCount,python:pythonCount,node:totalNode,worker:workerCount,node_sources:nodeSources,
    worker_sources:['push_crypto.mjs','worker_smoke.mjs','tatachat_smoke.mjs','tatachat_data_smoke.mjs']});
}
async function runCLI(operation) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { return await operation(controller.signal); }
  catch { process.stderr.write('公民服务端流程失败；未登记成功，请查看当前准确检查项。\n'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

async function flowReceipt(path,signal) {
  const receipt = JSON.parse((await bounded(path, 16 * 1024 ** 2)).toString());
  if (path !== join(receipt.work, 'resources.json')) fail('完整资源回执路径不符');
  await workDirectory(receipt.work);return receipt;
}

// Bash官方补丁使用context diff；精确匹配完整原行，拒绝删减上下文或多处匹配。
async function applyBashPatch(sourceRoot, patchBytes) {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(patchBytes), lines = text.split('\n');
  let file, content, offset = 0, applied = 0;
  async function flush() { if (file) await writeFile(file, content.join('\n')); }
  for (let at = 0; at < lines.length; at++) {
    if (/^\*\*\* [^0-9]/u.test(lines[at]) && /^--- [^0-9]/u.test(lines[at + 1] ?? '')) {
      await flush();
      const relative = lines[++at].slice(4).split(/\s/u)[0]; safeRelative(relative);
      file = join(sourceRoot, relative); content = (await readFile(await checked(file, 'file'), 'utf8')).split('\n'); offset = 0; continue;
    }
    const oldRange = /^\*\*\* ([0-9]+)(?:,([0-9]+))? \*\*\*\*$/u.exec(lines[at]);
    if (!oldRange) continue;
    if (!file) fail('Bash补丁缺少目标文件');
    const before = [], after = []; let newRange;
    for (at++; at < lines.length; at++) {
      newRange = /^--- ([0-9]+)(?:,([0-9]+))? ----$/u.exec(lines[at]); if (newRange) break;
      if (!/^(?:  |- |! )/u.test(lines[at])) fail('Bash补丁旧行格式无效');
      before.push(lines[at]);
    }
    if (!newRange) fail('Bash补丁新范围缺失');
    for (at++; at < lines.length && /^(?:  |\+ |! )/u.test(lines[at]); at++) after.push(lines[at]);
    at--;
    // 官方纯增加/删除hunk可省略未变化的一侧；该侧只从另一侧完整context行恢复。
    const old = (before.length ? before : after.filter(l => l.startsWith('  '))).map(l => l.slice(2));
    const next = (after.length ? after : before.filter(l => l.startsWith('  '))).map(l => l.slice(2));
    const oldLength = Number(oldRange[2] ?? oldRange[1]) - Number(oldRange[1]) + 1;
    const nextLength = Number(newRange[2] ?? newRange[1]) - Number(newRange[1]) + 1;
    if (old.length !== oldLength || next.length !== nextLength || !old.length) fail('Bash补丁范围与原行数不符');
    const same = position => position >= 0 && old.every((line, i) => content[position + i] === line);
    let position = Number(oldRange[1]) - 1 + offset;
    if (!same(position)) {
      // 上游补丁行号可来自较早快照；只接受全文唯一完整原行，绝不丢context或猜测。
      const matches = []; for (let i = 0; i + old.length <= content.length; i++) if (same(i)) matches.push(i);
      if (matches.length !== 1) fail('Bash补丁完整原行缺失或匹配歧义');
      position = matches[0];
    }
    content.splice(position, old.length, ...next); offset += next.length - old.length; applied++;
  }
  await flush(); if (!applied) fail('Bash补丁没有真实变更');
}
async function normalizeLinks(rootPath) {
  async function walk(at) {
    for (const name of await readdir(at)) {
      const path = join(at, name), st = await lstat(path);
      if (st.isSymbolicLink()) {
        const target = await realpath(path);
        if (!inside(rootPath, target) || !(await lstat(target)).isFile()) fail('原生安装链接越界或类型无效');
        const bytes = await readFile(target), mode = (await lstat(target)).mode & 0o777;
        await rm(path); await writeFile(path, bytes, {flag: 'wx', mode});
      } else if (st.isDirectory()) await walk(path);
      else if (!st.isFile()) fail('原生安装产生特殊文件');
      else if (st.nlink !== 1) {
        const bytes = await readFile(path); await rm(path);
        await writeFile(path, bytes, {flag: 'wx', mode: st.mode & 0o777});
      }
    }
  }
  await walk(rootPath);
}

function shellQuote(value) {
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) fail('工具脚本参数无效');
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

async function processTable() {
  if (process.platform !== 'linux') return null;
  const entries = await readdir('/proc'); const table = new Map();
  await Promise.all(entries.filter(n => /^[1-9][0-9]*$/u.test(n)).map(async name => {
    try {
      const text = await readFile('/proc/' + name + '/stat', 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).trim().split(' ');
      table.set(Number(name), {pid: Number(name), state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), start: fields[19]});
    } catch (e) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(e.code)) throw e; }
  }));
  return table;
}
function descendantTracker(pid) {
  const owned = new Map(); let current = Promise.resolve();
  function scan() {
    current = current.then(async () => {
      const table = await processTable(); if (!table) return null;
      let changed = true;
      while (changed) {
        changed = false;
        const rootValid = !owned.has(pid) || !table.has(pid) || table.get(pid).start === owned.get(pid);
        for (const value of table.values()) if (!owned.has(value.pid) && rootValid && (value.pid === pid ||
          value.parent === pid && (!owned.has(pid) || table.get(pid)?.start === owned.get(pid)) ||
          owned.has(value.parent) && table.get(value.parent)?.start === owned.get(value.parent) || value.group === pid)) { owned.set(value.pid, value.start); changed = true; }
      }
      return table;
    });
    return current;
  }
  async function stop() {
    const table = await scan();
    if (table) for (const [id, start] of owned) {
      const value = table.get(id); if (value?.start !== start || value.state === 'Z') continue;
      try { process.kill(id, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
  }
  async function quiet() {
    const table = await scan();
    if (table) return [...owned].every(([id, start]) => { const value = table.get(id); return !value || value.start !== start || value.state === 'Z'; });
    try { process.kill(-pid, 0); return false; } catch (e) { if (e.code !== 'ESRCH') throw e; return true; }
  }
  return {scan, stop, quiet};
}
// 可信Node直接展开已验真XZ，避免Mac准备Rust时调用系统xz或下载Linux解包工具。
// 格式依据 https://tukaani.org/xz/xz-file-format.txt；只接受本声明使用的单流LZMA2。
function xzCRC(bytes,width=32,initial){
 if(!xzCRC.tables){const table32=new Uint32Array(256),table64=[];for(let n=0;n<256;n++){let a=n,b=BigInt(n);for(let k=0;k<8;k++){a=(a>>>1)^((a&1)?0xedb88320:0);b=(b>>1n)^((b&1n)?0xc96c5795d7870f42n:0n);}table32[n]=a>>>0;table64[n]=b;}xzCRC.tables={table32,table64};}
 let value=initial??(width===32?0xffffffff:0xffffffffffffffffn);
 if(width===32){for(const byte of bytes)value=(value>>>8)^xzCRC.tables.table32[(value^byte)&255];return (value^0xffffffff)>>>0;}
 for(const byte of bytes)value=(value>>8n)^xzCRC.tables.table64[Number((value^BigInt(byte))&255n)];return value^0xffffffffffffffffn;
}
async function xzOutputCheck(bytes,kind,expected,signal){
 if(kind===0)return;
 const hash=kind===10?createHash('sha256'):null,width=kind===1?32:64,mask=width===32?0xffffffff:0xffffffffffffffffn;let value=width===32?0:0n;
 for(let at=0;at<bytes.length;at+=1024**2){signal?.throwIfAborted();await delay(0);const chunk=bytes.subarray(at,at+1024**2);if(hash)hash.update(chunk);else value=xzCRC(chunk,width,value^mask);}
 if(hash?!hash.digest().equals(expected):kind===1?value!==expected.readUInt32LE():value!==expected.readBigUInt64LE())fail('XZ展开校验失败');
}
function xzInteger(bytes,cursor,end){
 let value=0,scale=1;
 for(let n=0;n<9&&cursor.at<end;n++){const byte=bytes[cursor.at++];if(n&&byte===0)fail('XZ整数非规范');value+=(byte&127)*scale;if(!Number.isSafeInteger(value))fail('XZ整数超限');if(!(byte&128))return value;scale*=128;}
 fail('XZ整数截断');
}
async function lzma2Bytes(input,expected,dictionary,signal){
 const output=Buffer.alloc(expected);let pos=0,at=0,dictStart=0,initialized=false,props,models,state,reps;
 const probs=n=>new Uint16Array(n).fill(1024);
 function reset(){models={match:probs(192),rep:probs(12),g0:probs(12),g1:probs(12),g2:probs(12),short:probs(192),slot:probs(256),special:probs(114),align:probs(16),literal:probs(768*(1<<(props.lc+props.lp))),
  length:[{choice:probs(2),low:probs(128),mid:probs(128),high:probs(256)},{choice:probs(2),low:probs(128),mid:probs(128),high:probs(256)}]};state=0;reps=[0,0,0,0];}
 function read(){if(at>=input.length)fail('LZMA2截断');return input[at++];}
 function copy(distance,length,limit){
  if(distance>=dictionary||distance>=pos-dictStart||pos+length>limit)fail('LZMA2字典或长度越界');
  for(let n=0;n<length;n++){output[pos]=output[pos-distance-1];pos++;}
 }
 while(at<input.length){
  signal?.throwIfAborted();await new Promise(resolve=>setImmediate(resolve));const control=read();if(control===0){if(at!==input.length||pos!==expected)fail('LZMA2终态不符');return output;}
  if(control===1||control===2){const count=(read()<<8|read())+1;if(control===1){dictStart=pos;initialized=true;}else if(!initialized)fail('LZMA2未初始化字典');
   if(at+count>input.length||pos+count>expected)fail('LZMA2原始块越界');input.copy(output,pos,at,at+count);at+=count;pos+=count;models=undefined;continue;}
  if(control<128||!initialized&&control<224)fail('LZMA2控制字无效');
  const size=((control&31)<<16|(read()<<8)|read())+1,packed=(read()<<8|read())+1,limit=pos+size;
  if(control>=224){dictStart=pos;initialized=true;}
  if(control>=192){const value=read();if(value>=225)fail('LZMA2属性无效');props={lc:value%9,lp:Math.floor(value/9)%5,pb:Math.floor(value/45)};if(props.lc+props.lp>4)fail('LZMA2字面量属性越界');}
  if(control>=160){if(!props)fail('LZMA2缺少属性');reset();}else if(!models)fail('LZMA2状态未复位');
  if(limit>expected||at+packed>input.length||packed<5)fail('LZMA2压缩块越界');
  const start=at,end=at+packed;let range=0xffffffff,code=0;
  if(read()!==0)fail('LZMA2范围编码头无效');for(let n=0;n<4;n++)code=(code*256+read())>>>0;
  const normalize=()=>{if(range<0x1000000){if(at>=end)fail('LZMA2范围编码截断');range=(range*256)>>>0;code=(code*256+read())>>>0;}};
  const bit=(array,index)=>{normalize();const p=array[index];if(p===undefined)fail('LZMA2概率索引越界');const bound=(range>>>11)*p;let value;
   if(code<bound){range=bound>>>0;array[index]=p+((2048-p)>>>5);value=0;}else{range=(range-bound)>>>0;code=(code-bound)>>>0;array[index]=p-(p>>>5);value=1;}return value;};
  const tree=(array,offset,bits,reverse=false)=>{let symbol=1,value=0;for(let n=0;n<bits;n++){const b=bit(array,offset+symbol);symbol=symbol*2+b;if(reverse)value+=b*2**n;}return reverse?value:symbol-2**bits;};
  const direct=bits=>{let value=0;for(let n=0;n<bits;n++){normalize();range>>>=1;const b=code>=range?1:0;if(b)code=(code-range)>>>0;value=value*2+b;}return value;};
  const length=(which,ps)=>{const m=models.length[which];if(!bit(m.choice,0))return 2+tree(m.low,ps*8,3);if(!bit(m.choice,1))return 10+tree(m.mid,ps*8,3);return 18+tree(m.high,0,8);};
  while(pos<limit){
   if((pos&65535)===0){signal?.throwIfAborted();await delay(0);}
   const position=pos-dictStart,ps=position&((1<<props.pb)-1),index=state*16+ps;
   if(!bit(models.match,index)){
    const previous=pos>dictStart?output[pos-1]:0,context=((position&((1<<props.lp)-1))<<props.lc)+(previous>>>(8-props.lc)),offset=context*768;let symbol=1;
    if(state>=7){if(reps[0]>=position||reps[0]>=dictionary)fail('LZMA2字面量匹配越界');let match=output[pos-reps[0]-1];while(symbol<256){const mb=match>>>7&1;match=(match<<1)&255;const b=bit(models.literal,offset+((1+mb)<<8)+symbol);symbol=symbol*2+b;if(b!==mb)break;}}
    while(symbol<256)symbol=symbol*2+bit(models.literal,offset+symbol);
    output[pos++]=symbol-256;state=state<4?0:state<10?state-3:state-6;continue;
   }
   let count;
   if(bit(models.rep,state)){
    if(!bit(models.g0,state)){if(!bit(models.short,index)){state=state<7?9:11;copy(reps[0],1,limit);continue;}}
    else{let distance;if(!bit(models.g1,state))distance=reps[1];else{if(!bit(models.g2,state))distance=reps[2];else{distance=reps[3];reps[3]=reps[2];}reps[2]=reps[1];}reps[1]=reps[0];reps[0]=distance;}
    count=length(1,ps);state=state<7?8:11;
   }else{
    count=length(0,ps);state=state<7?7:10;reps[3]=reps[2];reps[2]=reps[1];reps[1]=reps[0];
    const slot=tree(models.slot,Math.min(count-2,3)*64,6);let distance=slot;
    if(slot>=4){const bits=(slot>>>1)-1;distance=(2+(slot&1))*2**bits;if(slot<14)distance+=tree(models.special,distance-slot-1,bits,true);else distance+=direct(bits-4)*16+tree(models.align,0,4,true);}
    reps[0]=distance;
   }
   copy(reps[0],count,limit);
  }
  normalize();if(code!==0||at!==end||at<start+5)fail('LZMA2范围编码未完整结束');
 }
 fail('LZMA2缺少结束字');
}
async function xzBytes(bytes,signal){
 if(bytes.length<32||bytes.length%4||!bytes.subarray(0,6).equals(Buffer.from([253,55,122,88,90,0]))||bytes[6]!==0||bytes[7]&240)fail('XZ流头无效');
 const check=bytes[7],checkSize={0:0,1:4,4:8,10:32}[check];if(checkSize===undefined)fail('XZ校验类型未实现');
 if(xzCRC(bytes.subarray(6,8))!==bytes.readUInt32LE(8))fail('XZ流头校验失败');
 const footer=bytes.length-12;if(bytes[footer+10]!==89||bytes[footer+11]!==90||bytes[footer+8]!==0||bytes[footer+9]!==check||xzCRC(bytes.subarray(footer+4,footer+10))!==bytes.readUInt32LE(footer))fail('XZ流尾校验失败');
 const indexSize=(bytes.readUInt32LE(footer+4)+1)*4,indexStart=footer-indexSize;
 if(indexStart<12||bytes[indexStart]!==0||xzCRC(bytes.subarray(indexStart,footer-4))!==bytes.readUInt32LE(footer-4))fail('XZ索引校验失败');
 const cursor={at:indexStart+1},count=xzInteger(bytes,cursor,footer-4);if(count<1||count>65536)fail('XZ块数量无效');
 const records=[];let total=0;for(let n=0;n<count;n++){const unpadded=xzInteger(bytes,cursor,footer-4),size=xzInteger(bytes,cursor,footer-4);if(unpadded<5||size<1||(total+=size)>4*1024**3)fail('XZ展开超限');records.push({unpadded,size});}
 if(bytes.subarray(cursor.at,footer-4).some(x=>x!==0))fail('XZ索引填充无效');
 const chunks=[];let block=12;
 for(const record of records){
  signal?.throwIfAborted();const headerSize=(bytes[block]+1)*4,headerEnd=block+headerSize;if(headerSize<8||headerEnd>indexStart||xzCRC(bytes.subarray(block,headerEnd-4))!==bytes.readUInt32LE(headerEnd-4))fail('XZ块头校验失败');
  const flags=bytes[block+1];if(flags&63)fail('XZ只接受单个LZMA2过滤器');const c={at:block+2};
  const compressed=flags&64?xzInteger(bytes,c,headerEnd-4):null,uncompressed=flags&128?xzInteger(bytes,c,headerEnd-4):null;
  if(xzInteger(bytes,c,headerEnd-4)!==33||xzInteger(bytes,c,headerEnd-4)!==1)fail('XZ过滤器不符');const prop=bytes[c.at++];if(prop>40||bytes.subarray(c.at,headerEnd-4).some(x=>x!==0))fail('XZ字典属性或填充无效');
  const dictionary=prop===40?0xffffffff:(2+(prop&1))*2**((prop>>>1)+11),packed=record.unpadded-headerSize-checkSize;
  if(packed<1||compressed!==null&&compressed!==packed||uncompressed!==null&&uncompressed!==record.size)fail('XZ块长度与索引不符');
  const dataEnd=headerEnd+packed,padding=(4-packed%4)%4,checkAt=dataEnd+padding,next=checkAt+checkSize;
  if(next>indexStart||bytes.subarray(dataEnd,checkAt).some(x=>x!==0))fail('XZ块越界或填充无效');
  const decoded=await lzma2Bytes(bytes.subarray(headerEnd,dataEnd),record.size,dictionary,signal);
  await xzOutputCheck(decoded,check,bytes.subarray(checkAt,next),signal);
  chunks.push(decoded);block=next;
 }
 if(block!==indexStart)fail('XZ块闭集不符');return Buffer.concat(chunks,total);
}

// 本机Build的公开需求覆盖实际编译闭包；协议需求仍由同一声明单独解析。
async function requirements(platform,work) {
 if(!((process.platform==='darwin'&&process.arch==='arm64')||(process.platform==='linux'&&process.arch==='x64')))fail('Build没有当前宿主实现');
 if(platform!=='cloudflare'||work!==join(root,'target/build/cloudflare'))fail('Build平台或固定工作根无效');
 return {...await flowRequirements('build'),protocol:await protocolRequirements()};
}
// 已验真的Xcode可以返回包内SDK符号链接；只接受原入口及真实目标都属于同一包。
async function resolveSDKPath(path,developerDirectory){
 await checked(developerDirectory,'directory');
 if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||!inside(developerDirectory,path))fail('SDK入口不属于当前Xcode');
 const sdk=await realpath(path);if(!inside(developerDirectory,sdk))fail('SDK真实目标越出当前Xcode');
 await checked(sdk,'directory');return sdk;
}
// Xcode官方命令别名只在同一包内解析；返回普通真实文件，调用身份由包装器保留。
async function resolveAppleToolPath(path,developerDirectory){
 await checked(developerDirectory,'directory');
 if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||!inside(developerDirectory,path))fail('Apple工具入口不属于当前Xcode');
 const actual=await realpath(path);
 if(!inside(developerDirectory,actual))fail('Apple工具真实目标越出当前Xcode');
 await checked(actual,'file');return actual;
}
async function macApple(work,wanted,signal){
 const tools={node:process.execPath},call=(path,args,environment={})=>runTool(path,args,{work,cwd:work,tools,signal,environment,timeout:60000});
 const developerDirectory=(await call('/usr/bin/xcode-select',['-p'])).stdout.trim(),environment={DEVELOPER_DIR:developerDirectory},slots={};
 for(const name of wanted.names)slots[name]=name==='xcrun'?'/usr/bin/xcrun':await resolveAppleToolPath((await call('/usr/bin/xcrun',['--find',name],environment)).stdout.trim(),developerDirectory);
 const sdk=(await call('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],environment)).stdout.trim();
 return {developerDirectory,tools:slots,sdk};
}
async function freezeResourceTree(path,writable=false){
 const info=await lstat(path);if(info.isSymbolicLink())return;
 if(info.isDirectory()){if(writable)await chmod(path,0o700);for(const name of await readdir(path))await freezeResourceTree(join(path,name),writable);if(!writable)await chmod(path,0o555);}
 else if(info.isFile())await chmod(path,writable?(info.mode|0o600):(info.mode&0o111?0o555:0o444));else fail('工具对象含特殊文件');
}
async function independentTool(wanted,options){
 const object=join(options.toolRoot,wanted.archive.sha256),payload=join(object,'payload');
 const deliver=async()=>({root:payload,path:join(payload,wanted.archive.executable),slots:Object.fromEntries(wanted.slots.map(slot=>[slot,join(payload,slot)]))});
 try{await checked(object,'directory');return await deliver();}catch(e){if(e.code!=='ENOENT')throw e;}
 if(options.offline)fail('离线缺少本产品工具');const pending=join(options.work,'.tool-object-'+randomUUID());await directory(pending);await directory(join(pending,'payload'));
 try{
  const file=await original(wanted.archive,options,'tool'),prepared=await prepareToolSupply(wanted,{...options,original:file.path,payload:join(pending,'payload')});
  assertWorkQuiescent(options.work);await freezeResourceTree(join(pending,'payload'));
  const value={version:wanted.version,archive_sha256:wanted.archive.sha256,root:payload,path:join(payload,wanted.archive.executable),original:file.path,
   slots:Object.fromEntries(wanted.slots.map(x=>[x,join(payload,x)]))};
  await writeFile(join(pending,'resource.json'),JSON.stringify(value)+'\n',{flag:'wx',mode:0o444});
  await directory(options.toolRoot);const lock=join(options.toolRoot,'.'+wanted.archive.sha256+'.lock');await mkdir(lock,{mode:0o700});
  try{options.signal?.throwIfAborted();try{await lstat(object);}catch(e){if(e.code!=='ENOENT')throw e;await rename(pending,object);}}finally{await rm(lock,{recursive:true});}
  return await deliver();
 }finally{assertWorkQuiescent(options.work);try{await freezeResourceTree(pending,true);await rm(pending,{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}}
}
// 已登记的单件辅助工具独立领取；产品测试不隐式准备门禁检查器。
async function supplyDeclaredTool(id,receipt,options={}){
 if(id!=='actionlint'||receipt?.product_id!=='citizenserve'||receipt.flow!=='test'||receipt.work!==fixedWork('test')
  ||receipt.mode!==options.mode)fail('辅助工具任务身份无效');
 const declared=(await flowDeclaration()).resources.tools.actionlint,host=process.platform+'-'+process.arch,archive=declared.platforms[host];
 if(!archive)fail('辅助工具没有当前宿主声明');
 const wanted={id,version:declared.version,archive,slots:[archive.executable]};
 let result;
 if(options.mode==='console'){
  if(typeof options.acquireTool!=='function')fail('控制台未交付辅助工具供给');
  result=await options.acquireTool(wanted);
 }else if(options.mode==='independent'){
  const {homedir}=await import('node:os');const base=join(homedir(),'.local/share/product-resources');
  result=await independentTool(wanted,{work:receipt.work,toolRoot:options.toolRoot??join(base,'tools/archives'),dependencyRoot:options.dependencyRoot??join(base,'rely/objects'),offline:options.offline,signal:options.signal,fetcher:options.fetcher});
 }else fail('辅助工具资源模式无效');
 await checked(result?.path,'file');return result.path;
}
// 缺件准备只使用产品本次声明、原件及同一公开能力；不导入或读取控制台源码和私有登记。
async function prepareToolSupply(wanted,options){
 const {work,payload,signal}=options;await workDirectory(work);await checked(payload,'directory');
 const requested=await flowRequirements('build'),declared=(await flowDeclaration()).resources.tools.actionlint,host=process.platform+'-'+process.arch;
 const extra=wanted.id==='actionlint'?{id:'actionlint',version:declared.version,archive:declared.platforms[host],slots:[declared.platforms[host].executable]}:null;
 const entry=requested.tools.find(x=>x.id===wanted.id)??extra;
 if(!entry||JSON.stringify(entry)!==JSON.stringify(wanted))fail('工具配方不属于本次Build需求');
 const bytes=await archive(options.original,wanted.archive,1024**3);
 if(wanted.id==='node'){
  const values=await unpack(bytes,wanted.archive.kind,options,{node:process.execPath});await materialize(values,payload,wanted.archive.root);
 }else if(wanted.id==='worker-build'){
  const stage=join(work,'.worker-build-'+randomUUID());await directory(stage);
  try{
   const rust=await options.acquireTool(requested.tools.find(x=>x.id==='rust')),apple=await options.acquireApple(requested.apple);
   const tools={node:process.execPath,...Object.fromEntries(Object.entries(rust.slots).map(([slot,path])=>[basename(slot),path])),...apple.tools};
   for(const name of ['home','tmp','cargo-home','cargo-target','prepare'])await directory(join(stage,name));await closeCommands(stage,tools);
   const source=join(stage,'source');await materialize(await unpack(bytes,'tar-gzip',{...options,work:stage},tools),source,wanted.archive.root);
   
   // 独立工具工作区只隔离Cargo祖先发现；原件和锁保持原始字节。
   const manifest=join(source,'Cargo.toml'),originalManifest=await readFile(manifest);if(/^\[workspace\]/mu.test(originalManifest.toString()))fail('工具原始工作区超出配方');await chmod(manifest,0o600);await writeFile(manifest,Buffer.concat([originalManifest,Buffer.from('\n[workspace]\n')]));
   const packages=(await flowDeclaration()).resources.worker_build_packages.map(x=>({...x,url:'https://static.crates.io/crates/'+x.name+'/'+x.name+'-'+x.version+'.crate'}));
   await cargoView(packages,join(stage,'vendor'),{...options,work:stage},tools);
   await writeFile(join(stage,'cargo-home/config.toml'),'[source.crates-io]\nreplace-with = "locked"\n[source.locked]\ndirectory = '+JSON.stringify(join(stage,'vendor'))+'\n[net]\noffline = true\n',{flag:'wx',mode:0o444});
   await runTool(tools.cargo,['build','--manifest-path',manifest,'--release','--locked','--offline','--bin','worker-build'],{work:stage,cwd:source,tools,signal,environment:{CC:tools.clang,AR:tools.ar,RANLIB:tools.ranlib,DEVELOPER_DIR:apple.developerDirectory,SDKROOT:apple.sdk,CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER:tools.clang}});
   assertWorkQuiescent(stage);await binaryFile(await bounded(join(stage,'cargo-target/release/worker-build'),256*1024**2),join(payload,'bin/worker-build'));
  }finally{if(unsafeWork.has(stage)){unsafeWork.add(work);fail('工具准备后代未退出，保留现场');}await rm(stage,{recursive:true,force:true});}
 }else{
  await installOrExtract();
 }
 async function installOrExtract(){
  const values=await unpack(bytes,wanted.archive.kind,options,{node:process.execPath});
  if(wanted.id==='rust'){await installRust(values,wanted.archive,payload);for(const component of wanted.components){const originalBytes=await original(component,options,'tool');await installRust(await unpack(originalBytes.bytes,component.kind,options,{node:process.execPath}),component,payload);}}
  else await materialize(values,payload,wanted.archive.root);
 }
 // 准备回执引用已验真原件；工具对象不再永久复制同一归档。
 return {schema:1,id:wanted.id,version:wanted.version,source_sha256:wanted.archive.sha256,original:options.original,payload};
}
async function readBuildResource(value,platform,work,signal){
 if(value?.schema!==1||value.product_id!=='citizenserve'||value.platform!==platform||value.flow!=='build'||value.work!==work||typeof value.run_id!=='string'
  ||value.receipt!==join(work,'resources.json'))fail('Build供给回执身份无效');
 const bytes=await bounded(value.receipt,64*1024**2);
 const receipt=JSON.parse(bytes);if(receipt.run_id!==value.run_id||receipt.work!==work||receipt.mode!==value.mode)fail('Build资源任务漂移');return receipt;
}
async function resourceEnvironment(platform,work,value,environment={},options={}){
 if(platform!=='cloudflare'||work!==join(root,'target/build/cloudflare'))fail('Build固定工作根无效');return (await readBuildResource(value,platform,work,options.signal)).environment;
}
async function buildSupply(request,options){
 await requirements(request.platform,request.work);
 const receipt=await prepareFlowResources({...options,flow:'build',work:request.work,runID:request.run_id}),path=join(request.work,'resources.json');
 return {schema:1,product_id:'citizenserve',platform:'cloudflare',flow:'build',work:request.work,run_id:request.run_id,mode:receipt.mode,receipt:path};
}
async function prepareResourceSupply(platform,work,previous,options={}){

 if(previous?.schema!==1||previous.product_id!=='citizenserve'||previous.platform!==platform||previous.work!==work||typeof previous.run_id!=='string')fail('公开Build资源请求身份不符');
 if(typeof options.acquireTool!=='function'||typeof options.acquireApple!=='function'||typeof options.acquireOriginal!=='function')fail('控制台公开资源能力不完整');
 const lock=await checked(join(work,'.product-build.lock'),'file'),owner=JSON.parse(await bounded(lock,65536));
 if(owner.run_id!==previous.run_id||owner.product_id!==previous.product_id||owner.platform!==platform)fail('资源准备与Build守卫不符');
 owner.supplier_pid=process.pid;owner.supply_quiet=false;await writeFile(lock,JSON.stringify(owner)+'\n');
 try{return await buildSupply(previous,{...options,mode:'console'});}
 finally{
  assertWorkQuiescent(work);const current=JSON.parse(await bounded(lock,65536));
  if(current.nonce!==owner.nonce||current.run_id!==owner.run_id||current.supplier_pid!==process.pid)fail('资源供给守卫漂移');
  current.supply_quiet=true;await writeFile(lock,JSON.stringify(current)+'\n');
 }

}

// 帧协议与原件准备解耦：通道只承载当前身份、需求摘要和小回执。





// 结果先由适配器验真并登记确认；守卫保留至控制台SQLite记录和同一短锁清场。


// 所属测试与生产实现同文件；普通导入和正式执行不注册测试。
// 完整GitHub构建与独立开发检查共享本仓实际领取根。


// BEGIN INLINE TESTS
if(inlineTestEntry&&process.env.PRODUCT_TEST_SCOPE!=='lifecycle'){
const {test} = await import('node:test');
const {default: assert} = await import('node:assert/strict');
const {mkdir, writeFile, symlink, rm, realpath, chmod, readFile} = await import('node:fs/promises');
const {join, resolve} = await import('node:path');
const {randomUUID,createHash} = await import('node:crypto');
const {gunzipSync} = await import('node:zlib');
const {Duplex} = await import('node:stream');
const {fileURLToPath} = await import('node:url');
// 直接检查本产品真实资源配方；所有临时文件限定在本次平台测试工作根。

// 用真实Node子进程验证测试注册边界，避免普通调用或其它测试导入时重复执行。
test('内嵌测试仅由自身测试入口注册，普通导入与测试导入不启动正式流程',async()=>fixture(async work=>{
 const paths=['scripts/build.mjs','scripts/tatachat.mjs'];
 const imports=paths.map(path=>'await import('+JSON.stringify('file://'+join(productRoot,path))+');').join('\n');
 const tools={node:process.execPath};
 const ordinary=await runTool(process.execPath,['--input-type=module','-e',imports+'\nprocess.stdout.write("loaded");'],{work,tools});
 assert.equal(ordinary.stdout,'loaded');assert.equal(ordinary.stderr,'');
 const entry=join(work,'imports.mjs');
 await writeFile(entry,imports+'\nconst {test}=await import("node:test");test("导入边界",()=>{});\n');
 const nested=await runTool(process.execPath,['--test',entry],{work,tools});
 assert.match(nested.stdout,/tests 1\b/u);assert.match(nested.stdout,/pass 1\b/u);assert.match(nested.stdout,/fail 0\b/u);
 // 自有reporter会在测试调度进程导入资源实现；该进程也不得启动正式CLI。
 const reported=await runTool(process.execPath,['--test','--test-name-pattern=^ZIP提取',
  '--test-reporter=tap',join(productRoot,'scripts/build.mjs')],{work,tools});
 assert.match(reported.stdout,/tests 1\b/u);assert.match(reported.stdout,/pass 1\b/u);assert.match(reported.stdout,/fail 0\b/u);
}));



async function fixture(callback) {
  const base = process.env.PRODUCT_WORK_DIR;
  assert.ok(base && resolve(base) === base && await realpath(base) === base);
  const work = join(base, 'resource-test-' + randomUUID());
  await mkdir(work, {mode: 0o700});
  try { await callback(work); } finally { assertWorkQuiescent(work); await rm(work, {recursive: true, force: true}); }
}
function zip(data = Buffer.from('synthetic executable'), change = () => {}) {
  const name = Buffer.from('bin/protoc');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  change(local, central, end);
  return Buffer.concat([local, name, data, central, name, end]);
}
test('独立临时原件只允许本轮固定根，正常缓存、离线、失败和取消保持真实结果', async () => fixture(async temporary => {
  const work = process.env.PRODUCT_WORK_DIR;
  const store = join(temporary, 'originals');
  const entry = {sha256: 'a'.repeat(64), url: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz'};
  const options = {mode: 'independent', work, dependencyRoot: store};
  let calls = 0;
  const first = await original(entry, {...options, fetcher: async () => { calls++; return new Response('original'); }}, 'dependency');
  assert.equal(first.bytes.toString(), 'original'); assert.equal(calls, 1);
  assert.equal((await original(entry, {...options, offline: true, fetcher: () => assert.fail('离线联网')}, 'dependency')).path, first.path);
  const absent = {...entry, sha256: 'b'.repeat(64)};
  await assert.rejects(original(absent, {...options, offline: true}, 'dependency'), /离线缺少/);
  await assert.rejects(original(absent, {...options, fetcher: async () => new Response('', {status: 503})}, 'dependency'), /获取失败/);
  const cancellation = new AbortController(); cancellation.abort();
  await assert.rejects(original(absent, {...options, signal: cancellation.signal, fetcher: () => assert.fail('取消后联网')}, 'dependency'), /abort/iu);
  const streamed = new AbortController();
  await assert.rejects(original(absent, {...options, signal: streamed.signal, fetcher: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('partial')); streamed.abort(); controller.close(); }
  }))}, 'dependency'), /abort/iu);
  assert.deepEqual(await readdir(store), [entry.sha256 + '.blob']);
  for (const rejected of [root, join(root, 'scripts', 'resource-forbidden-' + randomUUID()), fixedWork(work === fixedWork('build/cloudflare') ? 'test' : 'build'), join(fixedWork(work === fixedWork('build/cloudflare') ? 'test' : 'build'), 'foreign-originals')]) {
    const existed = await lstat(rejected).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
    await assert.rejects(original(absent, {...options, dependencyRoot: rejected, offline: true}, 'dependency'), /源码外或本轮/);
    if (!existed) await assert.rejects(lstat(rejected), {code: 'ENOENT'});
  }
  await assert.rejects(original(absent, {...options, dependencyRoot: store + '/../escape', offline: true}, 'dependency'), /路径无效/);
  await assert.rejects(original(absent, {...options, work: temporary, offline: true}, 'dependency'), /源码外或本轮/);
  const toolStore = join(temporary, 'tools'); await mkdir(toolStore);
  await assert.rejects(prepare({work, mode: 'independent', store, toolStore, offline: true}), /离线缺少/);
  assert.deepEqual(await readdir(toolStore), []);
}));

test('本机协议来自TataChatSDK仓库，自动化仍固定提交与protoc35', async () => {
  const local=await protocolRequirements('local');
  assert.equal(local.source_mode,'local');
  for(const item of local.archives){
    assert.ok(item.local_path.startsWith(join(dirname(root),'tatachatsdk')+sep));
    assert.equal(digest(await readFile(item.local_path)),item.sha256);
  }
  const value = await protocolRequirements('git');
  assert.equal(value.product_id, 'citizenserve'); assert.equal(value.platform, 'cloudflare');
  assert.equal(value.tools[0].version, '35.0');
  assert.deepEqual(value.archives.map(x => x.name), ['message.proto', 'attachment.proto', 'chat_frame.proto']);
  assert.ok(value.archives.every(x => new URL(x.url).protocol === 'https:' && /^[a-f0-9]{64}$/u.test(x.sha256)));
  // 消费当前真实提交的新协议目录；不接受旧src包装层或浮动引用。
  for (const entry of value.archives) {
    assert.equal(new URL(entry.url).pathname, '/tuyutata/tatachatsdk/b0485cf0a2c0922791741a748fdec0a49003089f/lib/protocol/' + entry.name);
  }
});

test('缺件控制台模式不能调用产品下载或切换独立模式', async () => fixture(async work => {
  let called = false;
  await assert.rejects(prepare({work, mode: 'console', fetcher: () => { called = true; throw Error(); }}), /供给身份/);
  assert.equal(called, false);
}));
test('供给身份必须绑定当前产品平台和工作根', async () => fixture(async work => {
  for (const field of ['product_id', 'platform', 'work']) {
    const supply = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', work, [field]: 'other'};
    await assert.rejects(prepare({work, mode: 'console', supply}), /身份/);
  }
}));
test('供给路径经过链接时先拒绝，不接触下载', async () => fixture(async work => {
  const link = join(work, 'link'); await symlink(work, link);
  const supply = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', work, dependency_root: work, tool_root: link};
  await assert.rejects(prepare({work, mode: 'console', supply}), /链接/);
}));
test('资源模式必须显式且永久存储不得进入源码', async () => fixture(async work => {
  await assert.rejects(prepare({work, mode: 'automatic'}), /显式/);
  await assert.rejects(prepare({work, mode: 'independent', store: work}), /源码外/);
}));

test('ZIP提取只返回固定入口的原始字节', () => {
  const data = Buffer.from('opaque synthetic executable');
  assert.deepEqual(protocBytes(zip(data)), data);
});
test('ZIP越界截断和错误入口被拒绝', () => {
  for (const value of [Buffer.alloc(0), zip().subarray(0, 20), zip(undefined, (_a, _b, end) => end.writeUInt32LE(0xffffffff, 16))]) {
    assert.throws(() => protocBytes(value));
  }
});
test('ZIP加密链接及大小不符不能生成工具', () => {
  for (const edit of [
    (a, b) => { a.writeUInt16LE(1, 6); b.writeUInt16LE(1, 8); },
    (_a, b) => b.writeUInt32LE((0o120777 << 16) >>> 0, 38),
    (_a, b) => b.writeUInt32LE(1, 24),
    (_a, b) => b.writeUInt16LE(1, 34),
  ]) assert.throws(() => protocBytes(zip(undefined, edit)));
});

test('Worker需求直接引用本产品唯一npm锁，不在源码安装',async()=>{const r=await protocolRequirements();assert.ok(r.locks.some(x=>x.ecosystem==='npm'&&x.path==='test/worker/package-lock.json'&&x.purpose==='worker_runtime_tests'));});
test('Worker任务身份不符在复制执行前失败',async()=>fixture(async work=>{
 const file=join(work,'worker.json');await writeFile(file,'{}');
 await assert.rejects(workerTestView(file,work),/流程/);
 const scope=work.slice(join(productRoot,'target').length+1).split('/')[0];
 const receipt={schema:1,product_id:'citizenserve',platform:'cloudflare',flow:scope==='test'?'test':'build',work,modules:join(work,'worker-smoke/test/worker/node_modules'),files:[{path:'example',bytes:1,sha256:'a'.repeat(64)}]};
 for(const change of [{schema:2},{product_id:'other'},{platform:'other'},{work:join(work,'other')},{modules:join(work,'other')}]){
  const bytes=Buffer.from(JSON.stringify({...receipt,...change}));await writeFile(file,bytes);
  await assert.rejects(workerTestView(file,work),/身份/);
 }
 assert.deepEqual((await (await import('node:fs/promises')).readdir(work)),['worker.json'],'错误身份不得生成工程或复制文件');
}));

// 完整流程资源回归只读取锁与合成归档；不获取或执行Linux原件。

test('Cargo锁逐坐标取官方原件，未知Git或漏摘要拒绝', () => {
  const source = '[[package]]\nname = "sample"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "' + 'a'.repeat(64) + '"\n';
  assert.equal(cargoPackages(source)[0].url, 'https://static.crates.io/crates/sample/sample-1.0.0.crate');
  assert.throws(() => cargoPackages(source.replace('registry+', 'git+')));
  assert.throws(() => cargoPackages(source.replace('a'.repeat(64), 'invalid')));
  assert.throws(() => cargoPackages('version = 4'));
});
test('npm锁按真实解析路径和libc选闭包，不把其它平台装进当前任务', () => {
  const packageEntry = (name, extra = {}) => ({version: '1.0.0', resolved: 'https://registry.npmjs.org/' + name + '/-/' + name + '-1.0.0.tgz', integrity: 'sha512-' + Buffer.alloc(64).toString('base64'), ...extra});
  const lock = {lockfileVersion: 3, packages: {'': {devDependencies: {app: '1.0.0'}},
    'node_modules/app': packageEntry('app', {optionalDependencies: {linux: '1.0.0', darwin: '1.0.0', musl: '1.0.0'}}),
    'node_modules/linux': packageEntry('linux', {os: ['linux'], cpu: ['x64'], libc: ['glibc']}),
    'node_modules/darwin': packageEntry('darwin', {os: ['darwin'], cpu: ['arm64']}),
    'node_modules/musl': packageEntry('musl', {os: ['linux'], cpu: ['x64'], libc: ['musl']})}};
  assert.deepEqual(npmPackages(lock, 'linux-x64').map(p => p.path), ['node_modules/app', 'node_modules/linux']);
  assert.deepEqual(npmPackages(lock, 'darwin-arm64').map(p => p.path), ['node_modules/app', 'node_modules/darwin']);
  delete lock.packages['node_modules/app']; assert.throws(() => npmPackages(lock, 'linux-x64'));
});
test('Mac与Linux按实际宿主选原件，产品测试不领取门禁检查器', async () => {
  const mac = await flowRequirements('test', 'darwin-arm64'), linux = await flowRequirements('test', 'linux-x64');
  assert.ok(mac.tools.every(t => !t.archive.url.includes('linux')));
  assert.ok(linux.tools.some(t => t.archive.url.includes('linux')));
  assert.equal(mac.tools.some(t=>t.id==='actionlint'),false);
  assert.equal(linux.tools.some(t=>t.id==='actionlint'),false);
  assert.ok(mac.npm.every(p => !p.path.includes('linux')));
  await assert.rejects(flowRequirements('test', 'windows-x64'));
});
test('工具环境忽略调用者PATH和下载覆盖变量，拒绝重写基础环境', () => {
  const tools = {node: '/verified/node', cargo: '/verified/cargo', git: '/verified/git'};
  const value = cleanEnvironment('/owned/work', tools);
  assert.equal(value.PATH, '/owned/work/bin'); assert.equal(value.PRODUCT_NODE_BIN, '/verified/node');
  assert.equal(value.CARGO_NET_OFFLINE, 'true'); assert.equal(value.MINIFLARE_WORKERD_PATH, undefined);
  assert.throws(() => cleanEnvironment('/owned/work', tools, {PATH: '/caller/path'}));
  assert.throws(() => cleanEnvironment('/owned/work', tools, {RUSTC_WRAPPER: '/caller/script'}));
});
function tarGzip(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    safeRelative(name); if (Buffer.byteLength(name) > 100) fail('夹具归档路径过长');
    const value = Buffer.from(data), header = Buffer.alloc(512);
    const field = (n, length, text) => header.write(text, n, length, 'ascii');
    field(0, 100, name); field(100, 8, '0000644\0'); field(108, 8, '0000000\0'); field(116, 8, '0000000\0');
    field(124, 12, value.length.toString(8).padStart(11, '0') + '\0'); field(136, 12, '00000000000\0');
    header.fill(32, 148, 156); header[156] = 48; field(257, 6, 'ustar\0'); field(263, 2, '00');
    const checksum = [...header].reduce((a, b) => a + b, 0); field(148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
    blocks.push(header, value, Buffer.alloc((512 - value.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks), {level: 9, mtime: 0});
}
test('归档闭集保持真实字节，路径、头校验和重复目录拒绝', () => {
  const entries = tarEntries(gunzipSync(tarGzip({'b.txt': Buffer.from('b'), 'a.txt': Buffer.from('a')})));
  assert.deepEqual([...entries.keys()], ['a.txt', 'b.txt']); assert.equal(entries.get('a.txt').data.toString(), 'a');
  for (const path of ['../outside', '/outside', 'a\\b', 'a//b', 'a/\nfile']) assert.throws(() => safeRelative(path));
  const broken = gunzipSync(tarGzip({'a.txt': Buffer.from('a')})); broken[0] ^= 1; assert.throws(() => tarEntries(broken));
  assert.deepEqual(zipEntries(zip(Buffer.from('data'))).get('bin/protoc').data, Buffer.from('data'));
});
test('退出0也须有真实非零用例，取消跳过和缺报告仍失败', () => {
  const value = {passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0}; assert.equal(requireSuccessCount(value, 'test'), value);
  for (const change of [{passed: 0}, {failed: 1}, {skipped: 1}, {todo: 1}, {cancelled: 1}, {passed: '1'}, {extra: true}]) {
    assert.throws(() => requireSuccessCount({...value, ...change}, 'test'));
  }
});


test('快速Node工具退出与非零失败均取得实际close，取消后才能清场', async () => fixture(async work => {
  const tools = {node: process.execPath};
  await assert.rejects(runTool(process.execPath, ['-e', 'process.exit(0)'], {work, cwd: resolve(work, '..'), tools}), /执行目录越界/u);
  const actual = await runTool(process.execPath, ['-e', 'process.stdout.write("completed")'], {work, cwd: work, tools});
  assert.equal(actual.stdout, 'completed');
  await assert.rejects(runTool(process.execPath, ['-e', 'process.exit(7)'], {work, cwd: work, tools}), /未完整成功/u);
  const controller = new AbortController(), ready = join(work, 'child-ready');
  const child = 'require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)';
  const pending = runTool(process.execPath, ['-e', child, ready], {work, cwd: work, tools, signal: controller.signal});
  const observed = assert.rejects(pending, /未完整成功|取消|aborted/iu);
  try {
    const {readFile} = await import('node:fs/promises'); let started = false;
    for (let n = 0; n < 100 && !started; n++) {
      try { started = (await readFile(ready, 'utf8')) === 'ready'; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!started) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(started, true, '必须真实启动子进程后再验证取消');
  } finally { controller.abort(); await observed; }
  assertWorkQuiescent(work);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(runTool(process.execPath, ['-e', 'process.exit(0)'], {work, cwd: work, tools, signal: cancelled.signal}));
}));
test('Bash官方context省略侧从完整上下文恢复，错原行与越界拒绝', async () => fixture(async work => {
  const source = join(work, 'sample.c'); await writeFile(source, 'first\nlast\n');
  const patch = Buffer.from('*** upstream/sample.c\n--- sample.c\n***************\n*** 1,2 ****\n--- 1,3 ----\n  first\n+ added\n  last\n');
  await applyBashPatch(work, patch);
  const {readFile} = await import('node:fs/promises'); assert.equal(await readFile(source, 'utf8'), 'first\nadded\nlast\n');
  await assert.rejects(applyBashPatch(work, Buffer.from('*** upstream/sample.c\n--- ../outside\n')), /路径/u);
  await assert.rejects(applyBashPatch(work, Buffer.from('*** upstream/sample.c\n--- sample.c\n***************\n*** 1,2 ****\n  absent\n! line\n--- 1,2 ----\n  absent\n! changed\n')), /原行/u);
}));


const productRoot=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/u,'');
// 实际文件系统验证包内版本链接，越界链接与非规范入口不能借真实目标通过。
test('SDK版本链接只解析到同一已验真Xcode包内的真实目录',async()=>fixture(async work=>{
 const {resolveSDKPath}=await import('./build.mjs');
 const developer=join(work,'Xcode.app/Contents/Developer'),sdk=join(developer,'SDKs/MacOSX.sdk');await mkdir(sdk,{recursive:true});
 const alias=join(developer,'SDKs/MacOSX27.0.sdk');await symlink(sdk,alias,'dir');
 assert.equal(await resolveSDKPath(alias,developer),sdk);assert.equal(await resolveSDKPath(sdk,developer),sdk);
 const outside=join(work,'outside');await mkdir(outside);const escape=join(developer,'SDKs/escaped.sdk');await symlink(outside,escape,'dir');
 await assert.rejects(resolveSDKPath(escape,developer),/越出/);
 await assert.rejects(resolveSDKPath(developer+'/SDKs/../SDKs/MacOSX.sdk',developer),/入口/);
 await assert.rejects(resolveSDKPath(outside,developer),/入口/);
 const file=join(developer,'SDKs/file.sdk');await writeFile(file,'not a directory');await assert.rejects(resolveSDKPath(file,developer),/类型/);
}));
test('本机完整Build的最小闭包及准确Mac标准库坐标来自产品声明',async()=>{
 const mac=await flowRequirements('build','darwin-arm64');
 assert.deepEqual(mac.tools.map(x=>x.id),['node','rust','protoc','worker-build','wasm-bindgen','wasm-opt']);
 assert.ok(mac.tools.every(x=>x.slots.length&&!Object.hasOwn(x,'recipe_sha256')));
 assert.equal(mac.tools.find(x=>x.id==='rust').components[0].sha256,'fa0edb6e9f34faae5735554d62d50875eded839dc707d0f1c01467a918d8453b');
 assert.deepEqual(mac.npm.map(x=>x.path).sort(),['node_modules/@esbuild/darwin-arm64','node_modules/esbuild']);
 assert.deepEqual(mac.apple.names,['clang','ar','ranlib','xcrun']);
 const linux=await flowRequirements('build','linux-x64');
 assert.equal(linux.tools.find(x=>x.id==='rust').components[0].sha256,'13902d5573eeea50701d75acc774b6df2dfb4942ec88cdbe40bb07e448c307ea');
 await assert.rejects(requirements('cloudflare',join(productRoot,'target/other')));
});


// 编译并执行build.rs中的实际路径判断，不复制另一套判定逻辑或构建整个Worker。
test('实际Rust构建判断接受固定build和test，拒绝旧平台根与越界根',async()=>fixture(async work=>{
 const compiler=process.env.RUSTC,linker=process.env.CC;
 assert.ok(compiler&&resolve(compiler)===compiler,'必须交付本轮已验真的Rust编译器');
 assert.ok(linker&&resolve(linker)===linker,'必须交付本轮已验真的宿主链接器');
 if(process.platform==='darwin')assert.ok(process.env.SDKROOT&&resolve(process.env.SDKROOT)===process.env.SDKROOT,'必须交付本轮已验真的macOS SDK');
 const source=await readFile(join(productRoot,'build.rs'),'utf8');
 const guard=source.match(/^fn require_work_root\b[\s\S]*?^\}/mu)?.[0];assert.ok(guard,'必须调用生产路径判断');
 const harness='use std::path::Path;\n'+guard+`\nfn main(){
 std::panic::set_hook(Box::new(|_|{}));let root=Path::new("/owned/citizenserve");
 for path in ["target/build/cloudflare","target/test"]{require_work_root(root,&root.join(path));}
 for path in ["target","target/cloudflare/build","target/cloudflare/test","target/ci","target/build/other"]{
  assert!(std::panic::catch_unwind(||require_work_root(root,&root.join(path))).is_err());
 }
 assert!(std::panic::catch_unwind(||require_work_root(root,Path::new("/other/target/build"))).is_err());
}\n`;
 for(const name of ['home','tmp','bin'])await mkdir(join(work,name));
 const input=join(work,'work.rs'),output=join(work,'work');await writeFile(input,harness);
 const options={work,tools:{node:process.execPath,rustc:compiler},environment:Object.fromEntries(['SDKROOT','DEVELOPER_DIR'].filter(name=>process.env[name]).map(name=>[name,process.env[name]]))};
 await runTool(compiler,['--edition=2021','-C','linker='+linker,input,'-o',output],options);
 await runTool(output,[],options);
}));

// 配置入口必须与产品公开产物声明一致；不要求target中的临时文件已经存在。
test('Wrangler入口解析到当前产品声明的Worker产物',async()=>{
 const config=await readFile(join(productRoot,'server/cloudflare/wrangler.toml'),'utf8');
 const main=config.match(/^main\s*=\s*"([^"\n]+)"$/mu)?.[1];assert.ok(main);
 const declared=structuredClone(contract);
 const entries=declared.platforms.cloudflare.files.filter(name=>name.endsWith('.js'));assert.equal(entries.length,1);
 assert.equal(resolve(productRoot,'server/cloudflare',main),join(productRoot,'target/build/cloudflare',entries[0]));
});

class ResourceWire extends Duplex{
 sent=[];_read(){} _write(data,_encoding,done){this.sent.push(JSON.parse(data.toString()));done();}
 reply(value){this.push(JSON.stringify(value)+'\n');}
}
function frameFixture(){
 const stream=new ResourceWire(),request={schema:1,product_id:'citizenserve',platform:'cloudflare',work:'/owned/build',run_id:'123456789'},plan={schema:1,product_id:'citizenserve',flow:'build',tools:[]};
 return {stream,request,plan};
}


// CPython官方LZMA测试的独立编码样本；输入为公共领域莎士比亚文本。
// 来源：https://github.com/python/cpython，v3.14.3标签的Lib/test/test_lzma.py。
// PSF许可证：https://docs.python.org/3/license.html；仅保存压缩样本和预期摘要，不执行其测试源码。
const xzGolden=Buffer.from('fd377a585a000004e6d6b4460200210116000000742fe5a3e0078003df5d00051407625819cddd6e9815e4b49d6f1dc4e50a03cc3268c75c86fff8e2fce7d9fe36b828a87764c222752e6e1ec3f28e8d8f02172fa63df0a2df2f4d89bedea71c7a182d5dd5ef138f725a15808cf88d6ffa129b237a2feff0fa460182a34d8ea174ca3620424624e551a498eede6ce87ff09d2c626e0b13d4a881e44ec8861533f57832a24f134051a1002fa5d04f97dc6faef77ac4cd53b6743c16f29c4923897564c63659d9eee6ce125de5f0aa962d5065ad653a04091bf7db370a861f70c84abaf4f056a9dcf0022547f9df3d3f151be128ce823dd649ac33120c52b7ae0db169039501bdbefa027301509d9658b1326ac84ca88462f6c3d4632d48936f4a6cd06951e46b840bc1b7bcb11788b1ca3f40f607eae678f1483132500f8ac9ea7577e3beaa69a957d080cd2363623599d85da9640cbda2dc576ced5547bf897946f7378176bd3598be6838185708f01b99353a1a3f724496a1040faeba85eb9d3540f583d337838a6306d49769cd741653826bf64b01767988919b3654da650dfd5d3a6bba6ca9bb61c334f972eb7d72dbc7db2a8f037adc3868ccc9d3bc6ca52dcbea4ba2c515c0e3c1865afbeb4ce133cf9ce31dc9edc206ccce2192e5fe9c5ea53977209b50a3504b0864f9e25a7da7bfedeb25240c82b82fb001a9262cf771687b519629f27196c380b412b0bae66ff421b45bd48a7710f7740cb3d9d5c3605e81113f3f5ca4998552d48e83c91e58bf61f1acb0eaead7d0ab18e2f2ede1b7c918cb53e43ec99548e8cb090d25ebc7242e6ff1f352171d62bbd855a55ecc53160187f32f93d1f076c072d7cca2476b7aca800efdd08bbbd24978b31e79ca2d30e37a5ed6d68f5ff19d509f69a7d1e89084dcbfcd6b798edc817fa3b22bbf04efd85cc4dfe1b001e993e359f11d59e86881cff177ccb4ef208b7c04ea83656abe1fd47a9c60d31a924106e58fa913099e3dfa1ce55f9f25761b6f115a4fd8f409dd4d162d04fc183c22434ddd677e62f6ef8e0cd0de7ca0278a0cd678ae214aa646881575003817bc3779b3d875ac5f858de7c1409cec7163a323adf19335b5295f0dec335d0f6f5d35d06d79079bee81b50fcf4b2b00c0e46210e40c1a209be09774f6a19e8530ba0c9a8dc88f07d7aec8f92b69dcb96bb03e6619b80da8f81f24a57b70c68830cedbcfca5f86ac8868368b5a2527d00abf0f9c22bae5869f0f37583d6d4e585bcc194655c98630bc90612b2a20ae5f24031ed3cd5fa09cdeaf343671a5c992d7cae3609d857db4ffb383fbb6caae600b777ffcd8ac566519c8170b5aad88eb23970313b1640f7b0c0477070d97bdd6c1c3423a95085e1056ae614802d9e30a5c0158f69c8a06752325be2aa1187685ec21093400000000566a3f754c55f3a60001fb07810f000074779950b1c467fb020000000004595a','hex');
test('真实压缩LZMA2样本逐字节摘要正确，无系统xz依赖',async()=>{const bytes=await xzBytes(xzGolden);assert.equal(bytes.length,1921);assert.equal(createHash('sha256').update(bytes).digest('hex'),'b64857892c3f1ff008e910d6f8786bffb7f6651b7c5ea58ae3b7975d3ac119de');});

test('XZ头、压缩数据、索引、尾损坏及截断均拒绝，取消不返回部分输出',async()=>{
 for(const offset of [8,40,xzGolden.length-16,xzGolden.length-12]){const bad=Buffer.from(xzGolden);bad[offset]^=1;await assert.rejects(xzBytes(bad));}
 await assert.rejects(xzBytes(xzGolden.subarray(0,-4)));
 const abort=new AbortController();abort.abort();await assert.rejects(xzBytes(xzGolden,abort.signal));
});
// 编排回归使用阶段能力记录调用；真实资源和进程行为由所属入口回归覆盖。
const successfulCounts={passed:1,failed:0,skipped:0,todo:0,cancelled:0};
const checkOptions={flow:'test',runID:'checks-regression',mode:'console',work:fixedWork('test')};
function stageFixture(change={}) {
 const calls=[],receipt={work:checkOptions.work},lifecycle={sources:['scripts/build.mjs'],counts:{...successfulCounts}};
 return {calls,receipt,lifecycle,stages:{
  lifecycle:async()=>{calls.push('lifecycle');return lifecycle;},
  claim:async()=>{calls.push('claim');return {work:checkOptions.work,finish:async()=>{calls.push('finish');}};},
  prepare:async()=>{calls.push('prepare');return receipt;},...change}};
}
test('生命周期与合同登记必须完整且互不重复',async()=>{
 const value=productTestSources();
 assert.deepEqual(checkSources(value),{lifecycle:['scripts/build.mjs'],contracts:['scripts/build.mjs','scripts/tatachat.mjs']});
 for(const mutate of [v=>v.lifecycle=[],v=>v.lifecycle.push('scripts/build.mjs'),v=>v.contracts.pop(),v=>v.contracts.push('scripts/build.mjs')]){
  const copy=structuredClone(value);mutate(copy);assert.throws(()=>checkSources(copy),/登记不完整/);
 }
});
test('生命周期TAP终态拒绝漏项、重复、空执行和任何非成功计数',()=>{
 const report='# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
 assert.deepEqual(tapCounts(report),{...successfulCounts,passed:2});
 for(const invalid of [report.replace('# pass 2\n',''),report+'# pass 2\n',report.replace('# tests 2','# tests 3'),
  report.replaceAll('2','0'),...['fail','cancelled','skipped','todo'].map(key=>report.replace('# '+key+' 0','# '+key+' 1'))])assert.throws(()=>tapCounts(invalid));
});
test('完整检查先前置再领取准备，并只消费同一次实际结果',async()=>{
 const f=stageFixture();
 const result=await checkStages(checkOptions,async receipt=>{
  f.calls.push('operation');assert.equal(receipt,f.receipt);
  assert.equal(requireLifecycle(receipt),f.lifecycle);assert.throws(()=>requireLifecycle(receipt),/实际前置/);return 'checked';
 },undefined,f.stages);
 assert.equal(result,'checked');assert.deepEqual(f.calls,['lifecycle','claim','prepare','operation','finish']);
 const unconsumed=stageFixture();await checkStages(checkOptions,async()=>{},undefined,unconsumed.stages);
 assert.throws(()=>requireLifecycle(unconsumed.receipt),/实际前置/);
});
test('生命周期失败或前置取消不得领取资源现场',async()=>{
 const f=stageFixture({lifecycle:async()=>{throw Error('preflight failure');}});
 await assert.rejects(checkStages(checkOptions,()=>{},undefined,f.stages),/preflight failure/);assert.deepEqual(f.calls,[]);
 const controller=new AbortController(),cancel=stageFixture();
 cancel.stages.lifecycle=async()=>{controller.abort(Error('preflight cancelled'));return cancel.lifecycle;};
 await assert.rejects(checkStages(checkOptions,()=>{},controller.signal,cancel.stages),/preflight cancelled/);assert.deepEqual(cancel.calls,[]);
 const skipped=stageFixture();skipped.lifecycle.counts.skipped=1;
 await assert.rejects(checkStages(checkOptions,()=>{},undefined,skipped.stages),/没有完整执行成功/);assert.deepEqual(skipped.calls,['lifecycle']);
});
test('准备失败、操作失败和领取后取消均调用本轮真实收尾协议',async()=>{
 for(const at of ['prepare','operation','cancel']){
  const f=stageFixture(),controller=new AbortController();
  if(at==='prepare')f.stages.prepare=async()=>{f.calls.push('prepare');throw Error('stage failure');};
  if(at==='cancel'){const claim=f.stages.claim;f.stages.claim=async()=>{const task=await claim();controller.abort(Error('stage failure'));return task;};}
  await assert.rejects(checkStages(checkOptions,async()=>{f.calls.push('operation');throw Error('stage failure');},controller.signal,f.stages),/stage failure/);
  assert.equal(f.calls.at(-1),'finish');assert.equal(f.calls.filter(v=>v==='finish').length,1);
  if(at==='cancel')assert.deepEqual(f.calls,['lifecycle','claim','finish']);
 }
});
test('完整检查拒绝旧回执、伪造成功和越界配置，且尚未执行工具',async()=>{
 await assert.rejects(productTests({work:'/invalid',lifecycle:successfulCounts}),/实际前置/);
 for(const change of [{flow:'release'},{mode:'unknown'},{runID:'bad/id'},{work:fixedWork('build/cloudflare')}]){
  const f=stageFixture();await assert.rejects(checkStages({...checkOptions,...change},()=>{},undefined,f.stages),/配置/);assert.deepEqual(f.calls,[]);
 }
});


test('Xcode工具的同包官方别名解析为普通真实文件',async()=>fixture(async work=>{
 const developer=join(work,'Xcode.app/Contents/Developer'),bin=join(developer,'Toolchains/Default/usr/bin');
 await mkdir(bin,{recursive:true});const actual=join(bin,'libtool'),alias=join(bin,'ranlib');
 await writeFile(actual,'fixture');await (await import('node:fs/promises')).symlink('libtool',alias);
 assert.equal(await resolveAppleToolPath(alias,developer),actual);assert.equal(await resolveAppleToolPath(actual,developer),actual);
}));
test('Xcode工具拒绝跨包别名、越界入口、目录和缺失目标',async()=>fixture(async work=>{
 const developer=join(work,'Xcode.app/Contents/Developer');await mkdir(developer,{recursive:true});
 const outside=join(work,'outside');await writeFile(outside,'fixture');
 const alias=join(developer,'escape');await (await import('node:fs/promises')).symlink(outside,alias);
 await assert.rejects(resolveAppleToolPath(alias,developer),/越出/);
 await assert.rejects(resolveAppleToolPath(outside,developer),/入口/);
 await assert.rejects(resolveAppleToolPath(developer+'/../Developer/escape',developer),/入口/);
 const directoryPath=join(developer,'directory');await mkdir(directoryPath);await assert.rejects(resolveAppleToolPath(directoryPath,developer),/类型/);
 await assert.rejects(resolveAppleToolPath(join(developer,'missing'),developer),/ENOENT/);
}));
test('实际工具包装器保留ranlib调用身份并沿用进程收尾',async()=>fixture(async work=>{
 const tools={node:process.execPath,ranlib:process.execPath};await closeCommands(work,tools);
 const result=await runTool(join(work,'bin/ranlib'),['-e','process.stdout.write(process.argv0)'],{work,cwd:work,tools});
 assert.equal(result.stdout,'ranlib');
}));
}
// END INLINE TESTS

return Object.freeze({protocolRequirements,protocBytes,prepare,workerTestView,productRoot,flowDeclaration,cargoPackages,npmPackages,flowRequirements,safeRelative,tarEntries,zipEntries,debData,materialize,cleanEnvironment,runTool,prepareFlowResources,claimWork,assertWorkQuiescent,requireSuccessCount,compileWorker,productTestSources,checkSources,lifecycleChecks,withProductTests,executeProductTests,validateAcceptance,productTests,runCLI,applyBashPatch,xzBytes,requirements,resolveSDKPath,prepareToolSupply,supplyDeclaredTool,resourceEnvironment,prepareResourceSupply});
})();
export const {protocolRequirements,protocBytes,prepare,workerTestView,productRoot,flowDeclaration,cargoPackages,npmPackages,flowRequirements,safeRelative,tarEntries,zipEntries,debData,materialize,cleanEnvironment,runTool,prepareFlowResources,claimWork,assertWorkQuiescent,requireSuccessCount,compileWorker,productTestSources,checkSources,lifecycleChecks,withProductTests,executeProductTests,validateAcceptance,productTests,runCLI,applyBashPatch,xzBytes,requirements,resolveSDKPath,prepareToolSupply,supplyDeclaredTool,resourceEnvironment,prepareResourceSupply}=resourceRuntime;

// 本仓守卫由本仓收尾；调用方只提供已消费结果的任务编号。
export async function finishBuild(work,{run_id}={}){
 if(work!==join(root,'target/build/cloudflare'))fail('编译收尾目录无效');
 const lock=join(work,'.product-build.lock');let owner;
 try{owner=JSON.parse(await readFile(await checked(lock,'file'),'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}
 if(owner.schema!==1||owner.product_id!=='citizenserve'||owner.platform!=='cloudflare'||owner.flow!=='build'||owner.work!==work||owner.run_id!==run_id||owner.supply_quiet===false)fail('编译收尾身份或资源退出未确认');
 for(const pid of [owner.pid,owner.supplier_pid].filter(value=>value!==undefined)){
  if(!Number.isSafeInteger(pid)||pid<2)fail('编译进程身份无效');try{process.kill(pid,0);fail('产品进程退出未确认');}catch(error){if(error.code!=='ESRCH')throw error;}
 }
 for(const name of ['.supply-active.json','.resource-active.json']){const path=join(work,name);let record;try{record=JSON.parse(await readFile(await checked(path,'file'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}if(!Number.isSafeInteger(record.pid)||record.pid<2||!Array.isArray(record.groups)||record.groups.some(pid=>!Number.isSafeInteger(pid)||pid<2))fail('资源进程身份无效');for(const pid of [record.pid,...record.groups.map(pid=>-pid)])try{process.kill(pid,0);fail('资源工具退出未确认');}catch(error){if(error.code!=='ESRCH')throw error;}}
 assertWorkQuiescent(work);const claim=join(root,'target/build/.claim-cloudflare');await mkdir(claim,{mode:0o700});const held=await lstat(claim);
 try{await writeFile(join(claim,'owner.json'),JSON.stringify({pid:process.pid,work})+'\n',{flag:'wx',mode:0o600});if(JSON.stringify(JSON.parse(await readFile(lock,'utf8')))!==JSON.stringify(owner))fail('编译守卫漂移');for(const name of await readdir(work))await rm(join(work,name),{recursive:true,force:true});await rmdir(work);}
 finally{const current=await lstat(claim);if(current.dev!==held.dev||current.ino!==held.ino)fail('编译收尾锁漂移');await rm(claim,{recursive:true});}
}
// CitizenServe唯一完整本机编译入口，资源供给与产品编译分别归所属公开接口。
import {Socket} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,mkdir,lstat,realpath,readdir,rm,rmdir,writeFile} from 'node:fs/promises';
import {join,dirname,resolve,basename,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),fail=message=>{throw Error('CitizenServe编译：'+message);},digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(base,value)=>typeof value==='string'&&value.startsWith(base+sep);
async function checked(path, kind, create = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('路径必须是规范绝对路径');
  if (create) {
    const parent = dirname(path);
    if (parent === path) fail('资源根无效');
    await checked(parent, 'directory');
    try { await mkdir(path, {mode: 0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  for (let at = path; ; at = dirname(at)) {
    const info = await lstat(at);
    if (info.isSymbolicLink() || await realpath(at) !== at) fail('路径经过链接');
    if (at === path) {
      if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) fail('资源类型无效');
    } else if (!info.isDirectory()) fail('父路径不是目录');
    if (dirname(at) === at) break;
  }
  return path;
}

async function bounded(path, maximum) {
  await checked(path, 'file');
  if ((await lstat(path)).size > maximum) fail('资源超限');
  const bytes = await readFile(path);
  if (bytes.length > maximum) fail('读取资源超限');
  return bytes;
}

async function directory(path) {
  try { return await checked(path, 'directory'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await directory(dirname(path)); await mkdir(path, {mode: 0o700}); return checked(path, 'directory');
  }
}

async function workDirectory(work) {
  await checked(work, 'directory');
  const base = join(root, 'target');
  if (!inside(base, work) || !['build', 'test'].includes(work.slice(base.length + 1).split(sep)[0])) fail('工作目录越界');
  return work;
}

async function assertWorkUnclaimed(work) {
  for (const name of ['.active.json', '.product-build.lock']) {
    try { await lstat(join(work, name)); fail('固定现场仍有活跃任务，禁止清空'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function readBuildResource(value,platform,work,signal){
 if(value?.schema!==1||value.product_id!=='citizenserve'||value.platform!==platform||value.flow!=='build'||value.work!==work||typeof value.run_id!=='string'
  ||value.receipt!==join(work,'resources.json'))fail('Build供给回执身份无效');
 const bytes=await bounded(value.receipt,64*1024**2);
 const receipt=JSON.parse(bytes);if(receipt.run_id!==value.run_id||receipt.work!==work||receipt.mode!==value.mode)fail('Build资源任务漂移');return receipt;
}
async function buildSupply(request,options){
 await requirements(request.platform,request.work);
 const receipt=await prepareFlowResources({...options,flow:'build',work:request.work,runID:request.run_id}),path=join(request.work,'resources.json');
 return {schema:1,product_id:'citizenserve',platform:'cloudflare',flow:'build',work:request.work,run_id:request.run_id,mode:receipt.mode,receipt:path};
}

export async function claimBuildWork(runID,work,{provided=false}={}){
 if(work!==join(root,'target/build/cloudflare')||typeof runID!=='string'||!/^[a-zA-Z0-9_-]{1,96}$/u.test(runID))fail('Build任务坐标无效');
 await directory(join(root,'target'));await directory(work);
 const lock=join(work,'.product-build.lock'),claim=join(root,'target/build/.claim-cloudflare');
 const lifecycle=process.env.PRODUCT_LIFECYCLE_RUN;
 if(lifecycle!==undefined&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(lifecycle))fail('生命周期运行身份无效');
 const marker={schema:1,product_id:'citizenserve',platform:'cloudflare',flow:'build',work,run_id:runID,pid:process.pid,nonce:randomUUID(),...(provided?{supplier_pid:process.ppid,supply_quiet:true}:{}),...(lifecycle?{lifecycle_run:lifecycle}:{})};
 let stat;
 async function short(action){await mkdir(claim,{mode:0o700});const held=await lstat(claim);try{await writeFile(join(claim,'owner.json'),JSON.stringify({pid:process.pid,work})+'\n',{flag:'wx',mode:0o600});return await action();}finally{const now=await lstat(claim);if(now.dev!==held.dev||now.ino!==held.ino)fail('Build短锁漂移');await rm(claim,{recursive:true});}}
 async function owner(){const info=await lstat(lock),value=JSON.parse(await readFile(await checked(lock,'file')));if(info.dev!==stat.dev||info.ino!==stat.ino||value.supply_quiet===false||Object.entries(marker).some(([key,v])=>value[key]!==v))fail('Build守卫或资源后代退出未确认');return value;}
 await short(async()=>{await assertWorkUnclaimed(work);await writeFile(lock,JSON.stringify(marker)+'\n',{flag:'wx',mode:0o600});stat=await lstat(lock);
  try{if(!provided)for(const name of await readdir(work))if(![basename(lock),basename(claim)].includes(name))await rm(join(work,name),{recursive:true,force:true});if(!provided&&(await readdir(work)).some(name=>![basename(lock),basename(claim)].includes(name)))fail('Build清空回读失败');}
  catch(error){await rm(lock);throw error;}});
 return {async ready(){assertWorkQuiescent(work);const value=await owner();value.quiet=true;await writeFile(lock,JSON.stringify(value)+'\n');},
 async finish(){assertWorkQuiescent(work);await short(async()=>{await owner();await rm(lock);for(const name of await readdir(work))await rm(join(work,name),{recursive:true,force:true});if((await readdir(work)).length)fail('Build收尾未清空');await rmdir(work);});}};
}

export async function buildOutputDigest(path){
 const info=await lstat(await checked(path,'file')),bytes=await bounded(path,256*1024**2);
 return digest(Buffer.concat([Buffer.from(JSON.stringify(['','file',Boolean(info.mode&0o111),bytes.length])+'\n'),bytes]));
}

export async function executeBuild(request,options={}){
 const {signal}=options,work=request?.work;
 const keys=['schema','product_id','platform','work','run_id','program_digest'];
 if(!request||Object.keys(request).some(x=>!keys.includes(x))||request.schema!==1||request.product_id!=='citizenserve'||request.platform!=='cloudflare'||request.program_digest!==undefined&&!/^[a-f0-9]{64}$/u.test(request.program_digest))fail('完整Build请求无效');
 if(!((process.platform==='darwin'&&process.arch==='arm64')||(process.platform==='linux'&&process.arch==='x64')))fail('Cloudflare Build没有当前宿主实现');
 const provided=process.env.PRODUCT_RESOURCE_FD==='4';
 const guard=await claimBuildWork(request.run_id,work,{provided});
 try{
  const resources=options.stages?.resources?await options.stages.resources(request):provided?await requestBuildResources(new Socket({fd:4,readable:true,writable:true}),request,signal):await buildSupply(request,{...options,mode:'independent'});
  const receipt=await readBuildResource(resources,'cloudflare',work,signal);await (options.stages?.compile||compileWorker)(receipt,signal);assertWorkQuiescent(work);
  const d=await flowDeclaration(),files=[];for(const name of d.platforms.cloudflare.files){if(!name.startsWith('worker/'))fail('Build输出声明漂移');const path=join(work,name);files.push({path,sha256:await buildOutputDigest(path)});}
  signal?.throwIfAborted();if(files.length!==2)fail('Build必须验真两件实际Worker输出');
  const result={schema:1,product_id:'citizenserve',platform:'cloudflare',work,run_id:request.run_id,completion:'compile-only',files};
  if(options.consume)await options.consume(result,receipt);return result;
 }finally{
  if(provided)await guard.ready();else await guard.finish();
  // 控制台在完成同一结果核验、状态收口后清场；独立执行只保留本次返回的有界摘要。
  // 独立及失败的清场已在guard.finish的同一短锁内完成。
 }
}

export async function completeResourceSupply(platform,work,result,{process_id,signal}={}){
 signal?.throwIfAborted();if(platform!=='cloudflare'||work!==join(root,'target/build/cloudflare')||result?.work!==work||result.platform!==platform||result.product_id!=='citizenserve')fail('Build完成身份无效');
 const lock=await checked(join(work,'.product-build.lock'),'file'),owner=JSON.parse(await bounded(lock,65536));
 if(!Number.isSafeInteger(process_id)||process_id<2||owner.schema!==1||owner.work!==work||owner.flow!=='build'||owner.supplier_pid!==process.pid||owner.supply_quiet!==true||owner.pid!==process_id||owner.run_id!==result.run_id||owner.product_id!==result.product_id||owner.platform!==platform||owner.quiet!==true||owner.supply_quiet===false)fail('Build进程或完成守卫不符');
 try{process.kill(process_id,0);fail('Build子进程仍未退出');}catch(error){if(error.code!=='ESRCH')throw error;}
 owner.controller_id=process.pid;owner.result_verified=true;await writeFile(lock,JSON.stringify(owner)+'\n');
}

export async function requestBuildResources(stream,request,signal){
 return exchangeBuildResourceFrame(stream,request,signal);
}

export function exchangeBuildResourceFrame(stream,request,signal){
 return new Promise((ok,reject)=>{
  let buffer='',ended=false;const finish=(error,value)=>{if(ended)return;ended=true;signal?.removeEventListener('abort',abort);stream.destroy();error?reject(error):ok(value);},abort=()=>finish(Error('Build资源请求已取消'));
  signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});stream.setEncoding('utf8');
  stream.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>2*1024**2)return finish(Error('Build资源回执超限'));const end=buffer.indexOf('\n');if(end<0)return;
   try{if(buffer.slice(end+1))throw Error('Build资源回执不是唯一帧');const reply=JSON.parse(buffer.slice(0,end));if(reply.id!=='1'||reply.ok!==true||Object.keys(reply).sort().join(',')!=='id,ok,value')throw Error(reply.error||'Build资源供给失败');const value=reply.value;
    if(value?.run_id!==request.run_id||value.mode!=='console')throw Error('Build资源任务漂移');finish(null,value);
   }catch(error){finish(error);}});
  stream.on('end',()=>finish(Error('Build资源通道提前结束')));stream.on('error',()=>finish(Error('Build资源通道失败')));stream.on('close',()=>{if(!ended)finish(Error('Build资源通道中断'));});
  stream.write(JSON.stringify({id:'1',operation:'prepare',previous:request})+'\n');
 });
}
async function readBuildInput(){let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>2*1024**2)fail('公开输入超限');}const value=input?JSON.parse(input):{};if(!value||typeof value!=='object'||Array.isArray(value))fail('公开输入必须是对象');return value;}
async function buildMain(argv){
 if(process.version!=='v'+contract.resources.bootstrap.node_version)fail('产品Node必须使用唯一登记版本');
 const [command,platform,flag,work,...extra]=argv;
 if(command==='describe'){if(argv.length!==1)fail('编译声明不接受参数');process.stdout.write(JSON.stringify(contract)+'\n');return;}
 if(command==='finish'){if(argv.length!==2||!['cloudflare','test'].includes(platform))fail('平台收尾参数无效');finishFixedWork(fixedWork(platform==='test'?'test':'build/'+platform));return;}
 if(command==='protocol-requirements'){if(argv.length!==1)fail('协议需求参数无效');process.stdout.write(JSON.stringify(await protocolRequirements())+'\n');return;}
 const controller=new AbortController();for(const name of ['SIGINT','SIGTERM'])process.once(name,()=>controller.abort());
 if(command==='protocol-prepare'){if(argv.length!==2)fail('协议准备参数无效');const input=JSON.parse(await bounded(platform,65536));process.stdout.write(JSON.stringify(await prepare({...input,signal:controller.signal}))+'\n');return;}
 if(!['execute','test','requirements'].includes(command)||platform!=='cloudflare'||flag!=='--work'||extra.some(value=>value!=='--offline')||extra.length>1)fail('产品入口参数无效');
 if(command==='requirements'){process.stdout.write(JSON.stringify(await requirements(platform,work))+'\n');return;}
 const input=await readBuildInput(),allowed=['run_id','program_digest'];
 if(Object.keys(input).some(key=>!allowed.includes(key)))fail('产品入口仅接受本次任务信息');
 const run_id=input.run_id||randomUUID();
 const options={mode:'independent',signal:controller.signal,offline:extra.includes('--offline'),toolRoot:process.env.PRODUCT_TOOL_ROOT,dependencyRoot:process.env.PRODUCT_DEPENDENCY_ROOT};
 let result;
 if(command==='test'){
  if(work!==fixedWork('test'))fail('产品测试只使用固定test目录');
  result=await executeProductTests({...options,flow:'test',work,runID:run_id},controller.signal);
 }else result=await executeBuild({schema:1,product_id:'citizenserve',platform,work,run_id,...(input.program_digest===undefined?{}:{program_digest:input.program_digest})},options);
 process.stdout.write(JSON.stringify(result)+'\n');
}
if(directEntry&&!inlineTestEntry)void buildMain(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});

// Worker公开入口用真实文件事务验证；编译端口为合成能力，不获取工具或连接云端。
if(inlineTestEntry&&process.env.PRODUCT_TEST_SCOPE!=='lifecycle'){
 const {test}=await import('node:test'),{default:assert}=await import('node:assert/strict');
 const {mkdtemp,realpath}=await import('node:fs/promises');
 const stages=()=>({resources:async request=>{
  const value={schema:1,product_id:'citizenserve',platform:'cloudflare',flow:'build',work:request.work,run_id:request.run_id,mode:'independent',tools:{},environment:{}};
  await writeFile(join(request.work,'resources.json'),JSON.stringify(value));
  return {...value,receipt:join(request.work,'resources.json')};
 },compile:async receipt=>{await mkdir(join(receipt.work,'worker'));await writeFile(join(receipt.work,'worker/index.js'),'export default {};');await writeFile(join(receipt.work,'worker/index_bg.wasm'),Buffer.from([0,97,115,109,1,0,0,0]));}});
 test('Worker完整编译入口只交付两件输出并在独立成功和失败后清场',async()=>{
  const work=fixedWork('build/cloudflare'),request={schema:1,product_id:'citizenserve',platform:'cloudflare',work,run_id:'worker-unit'};
  const result=await executeBuild(request,{stages:stages()});
  assert.equal(result.completion,'compile-only');assert.equal(result.files.length,2);await assert.rejects(lstat(work),{code:'ENOENT'});
  const failed=stages();failed.compile=async()=>{throw Error('synthetic compiler failure');};
  await assert.rejects(executeBuild(request,{stages:failed}),/synthetic compiler failure/u);await assert.rejects(lstat(work),{code:'ENOENT'});
  await assert.rejects(executeBuild({...request,platform:'linux-arm'},{stages:stages()}),/请求无效/u);
 });
 test('公开声明来自唯一Build，Rust协议消费回执而非脚本或声明文件',async()=>{
  assert.equal(contract.entry,'scripts/build.mjs');assert.equal(contract.resource_entry,'scripts/build.mjs');
  assert.deepEqual(Object.keys(contract.platforms),['cloudflare']);
  const source=await readFile(join(root,'build.rs'),'utf8');assert.match(source,/delivery\["files"\]/u);
  assert.doesNotMatch(source,/scripts\/(?:flows\.json|resources\.mjs)/u);
  assert.throws(()=>cleanEnvironment(fixedWork('test'),{node:process.execPath},{UNDECLARED_SECRET:'synthetic'}),/未知字段/u);
 });
}
