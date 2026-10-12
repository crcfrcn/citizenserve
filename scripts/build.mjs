#!/usr/bin/env node
// 公民服务独立拥有声明、资源、现场及Worker编译；其它流程只调用公开接口。
export const contract=Object.freeze({
  "schema": 1,
  "product_id": "citizenserve",
  "platforms": {
    "cloudflare": {
      "files": [
        "worker/index.js",
        "worker/index_bg.wasm"
      ]
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
        "linux-x64": {
          "url": "https://github.com/protocolbuffers/protobuf/releases/download/v35.0/protoc-35.0-linux-x86_64.zip",
          "sha256": "a45cda0989c17dd950db55f6fbe1e5814c50fda08e87aa422980ac1f89dddbbc"
        }
      }
    }
  },
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
        }
      }
    },
    "tools": {
      "perl": {
        "version": "5.42.3",
        "platforms": {
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
          "linux-x64": null
        }
      },
      "rust": {
        "version": "1.97.1",
        "platforms": {
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
          "linux-x64": null
        }
      },
      "wasm-bindgen": {
        "version": null,
        "platforms": {
          "linux-x64": null
        }
      },
      "wasm-opt": {
        "version": null,
        "platforms": {
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
    ]
  }
});
// 本机与GitHub的同一Build入口读取产品Cargo声明；不复制Linux工具来源。
import {readFileSync as readServeManifest} from 'node:fs';
import {fileURLToPath as serveFilePath} from 'node:url';
import {join as serveJoin,resolve as serveResolve} from 'node:path';
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


// GitHub Runner调用同一产品编译入口；工作根只用于Cloudflare编译。
const buildSourceRoot=serveResolve(serveFilePath(new URL('../',import.meta.url)));
export function fixedWork(scope){
 if(scope==='build/cloudflare')return serveJoin(buildSourceRoot,'target/build/cloudflare');
 throw Error('CitizenServe编译工作根用途无效');
}

const resourceRuntime=await(async()=>{
const {readFileSync}=await import('node:fs');
// 聊天协议资源配方归本产品；控制台供给与独立准备共用同一声明及验真。
const {createHash, randomUUID}=await import('node:crypto');
const {spawn}=await import('node:child_process');
const {inflateRawSync, gunzipSync, gzipSync, zstdDecompressSync}=await import('node:zlib');
const {lstat, realpath, readFile, writeFile, mkdir, rename, rm, link, readdir, chmod}=await import('node:fs/promises');
const {basename, dirname, isAbsolute, join, resolve, sep}=await import('node:path');
const {fileURLToPath}=await import('node:url');

const unsafeWork = new Set();
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fail = message => { throw Error('聊天资源：' + message); };
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
async function declaration() {
  const data=structuredClone(contract);
  if (data.schema !== 1 || data.product_id !== 'citizenserve' || !data.tatachat) fail('所属产品声明缺失');
  const value = data.tatachat;
  if ((!/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9-]+\.git$/u.test(value.protocol?.source)
      || !/^[a-f0-9]{40}$/u.test(value.protocol.commit)
      || value.protocol.files?.length !== 3
      || new Set(value.protocol.files.map(x => x.name)).size !== 3)) fail('固定协议来源无效');
  for (const file of value.protocol.files) {
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
  if (work!==join(root,'target/build/cloudflare')) fail('工作目录越界');
  return work;
}
async function protocolRequirements() {
  const {value, archive} = await declaration();
  const repository = value.protocol.source.slice('https://github.com/'.length, -4);
  return {schema: 1, product_id: 'citizenserve', platform: 'cloudflare',
    locks: [{ecosystem: 'cargo', path: 'Cargo.lock'}, {ecosystem: 'npm', path: 'test/worker/package-lock.json', purpose:'worker_build'}],
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
async function prepare({work, mode, store, toolStore = store, offline = false, signal, fetcher = fetch}) {
  await workDirectory(work);
  if (mode !== 'independent') fail('供给模式必须为独立编译');
  const requested = await protocolRequirements();
  let originals, executable, originalPath;
  signal?.throwIfAborted();
  await originalStore(store, work);
  const options = {offline, signal, fetcher};
  const entry = requested.tools[0].archive;
  if (toolStore !== store) await originalStore(toolStore, work);
  executable = protocBytes(await fetchOriginal(entry, toolStore, options));
  originalPath = join(toolStore, entry.sha256 + '.blob'); originals = [];
  for (const file of requested.archives) originals.push(await fetchOriginal(file, store, options));
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
// 完整流程的资源需求从本仓声明和两份锁读取；不复制控制台工具实现。
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
  if (flow!=='build' || host!=='linux-x64') fail('流程资源身份无效');
  const d = await flowDeclaration();
  const ids = ['node','rust','protoc','worker-build','wasm-bindgen','wasm-opt'];
  const tools = ids.map(id => {
    const value = id === 'node' ? {version: d.resources.bootstrap.node_version, platforms: d.resources.bootstrap.platforms} : d.resources.tools[id];
    const archive = value?.platforms[host];
    if (!archive) fail('当前宿主缺少工具配方：' + id);
    return {id, version: value.version, archive,slots:id==='rust'?['bin/cargo','bin/rustc','bin/rustdoc']:[archive.executable],...(id==='rust'?{components:[{...d.resources.tools.rust.std.platforms[host],target:d.resources.tools.rust.std.target}]}:{})};
  });
  return {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', flow, host, tools,
    cargo: cargoPackages((await readFile(join(root, 'Cargo.lock'))).toString()),
    npm: npmPackages(JSON.parse(await readFile(join(root, 'test/worker/package-lock.json'))), host,['node_modules/esbuild'])};
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
    // Ubuntu官方Deb的常规条目以./开头；仅去掉该前缀，再执行原有越界校验。
    if (name.startsWith('./')) name = name.slice(2);
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
    PATH: join(work, 'bin'), PRODUCT_WORK_DIR: work, PRODUCT_ROOT: root, PRODUCT_FLOW_RESOURCE_RECEIPT: join(work, 'resources.json'), PRODUCT_NODE_BIN: tools.node,
    CARGO: tools.cargo, RUSTC: tools.rustc, RUSTDOC: tools.rustdoc, CARGO_HOME: join(work, 'cargo-home'),
    CARGO_TARGET_DIR: join(work, 'cargo-target'), CARGO_NET_OFFLINE: 'true', CARGO_INCREMENTAL: '0',
    WORKER_BUILD: tools['worker-build'],
    WASM_BINDGEN_BIN: tools['wasm-bindgen'], WASM_OPT_BIN: tools['wasm-opt'], ESBUILD_BIN: tools.esbuild,
    PROTOC: tools.protoc, WRANGLER_SEND_METRICS: 'false'};
  for (const [key, value] of Object.entries(extra)) {
    if (Object.hasOwn(environment, key)) { if (value !== environment[key]) fail('基础工具环境漂移'); continue; }
    if (!['TATACHAT_RESOURCE_RECEIPT', 'TATACHATSDK_PROTOCOL_DIR',
      'OPENSSL_DIR', 'OPENSSL_STATIC', 'CC', 'CXX', 'AR', 'RANLIB', 'CONFIG_SHELL', 'SHELL',
      'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER'].includes(key)) fail('工具环境有未知字段');
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
  if (store === root || inside(root, store)) fail('原件存储必须位于源码外');
  await directory(store);
  return store;
}

async function original(entry, options, kind) {
  const maximum = 1024 ** 3;
  if (options.mode !== 'independent') fail('原件只由产品独立准备');
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
  const permitted = new Set(['rustc', 'cargo',
    'rust-std-x86_64-unknown-linux-gnu', 'rust-std-wasm32-unknown-unknown']);
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
async function nativeLinux(id, archive, options, tools) {
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
  if (id === 'zlib') {
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
async function npmView(packages, work, options, tools) {
  const modules = join(work, 'npm/node_modules');
  await directory(modules);
  for (const entry of packages) {
    const resource = await original(entry, options, 'dependency');
    const path = join(work, 'npm', entry.path);
    await materialize(await unpack(resource.bytes, 'tar-gzip', options, tools), path, 'package');
    const value = JSON.parse(await readFile(join(path, 'package.json')));
  }
  const packageName = '@esbuild/linux-x64';
  const esbuild = join(modules, packageName, 'bin/esbuild');
  // 替代上游postinstall的唯一必要字节物化；不执行npm生命周期脚本。
  await rm(join(modules, 'esbuild/bin/esbuild'), {force: true});
  await binaryFile(await bounded(esbuild, 64 * 1024 ** 2), join(modules, 'esbuild/bin/esbuild'));
  return {esbuild};
}
async function prepareFlowResources(options) {
  options={...options};
  if(options.mode!=='independent')fail('GitHub编译只使用产品独立资源准备');
  const {homedir}=await import('node:os'),base=join(homedir(),'.local/share/product-resources');options.toolRoot??=join(base,'tools/archives');options.dependencyRoot??=join(base,'rely/objects');
  const {flow, work, mode, signal} = options;
  await workDirectory(work);
  const requested = await flowRequirements(flow);
  const d = await flowDeclaration(), tools = {};
  for (const name of ['home', 'tmp']) await directory(join(work, name));
  if (process.report.getReport().header.glibcVersionRuntime !== '2.39') fail('Linux引导要求实际Ubuntu24.04的glibc2.39');
  {
    const bootstrap = await original(d.resources.bootstrap.platforms[requested.host], options, 'tool');
    const entries = await unpack(bootstrap.bytes, 'tar-gzip', options, tools);
    const nodeBytes = entries.get(d.resources.bootstrap.platforms[requested.host].root + '/bin/node')?.data;
    if(!nodeBytes?.equals(await readFile(process.execPath)))fail('GitHub Runner Node与锁定官方原件不一致');
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
    const z = await nativeLinux('zlib', helpers.zlib, options, tools); tools.zlibPrefix = z.prefix;
    for (const id of ['perl','openssl']) {
      const toolArchive = d.resources.tools[id].platforms[requested.host];
      const value = await nativeLinux(id, toolArchive, options, tools);
      tools[id] = value.path;
      if (id === 'openssl') tools.opensslPrefix = value.prefix;
      await closeCommands(work, {node:tools.node,sh: tools.sh, [id]: value.path});
    }
    for (const tool of requested.tools.filter(x => !['node', 'worker-build'].includes(x.id))) {
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
        Object.assign(tools, Object.fromEntries(['cargo', 'rustc', 'rustdoc'].map(id => [id, join(prefix, 'bin', id)])));
      } else {
        await materialize(values, prefix, tool.archive.root); tools[tool.id] = join(prefix, tool.archive.executable);
      }
    }
    await closeCommands(work, tools);
  }
  for (const name of ['home', 'tmp', 'cargo-home', 'cargo-target', 'bin', 'prepare']) await directory(join(work, name));
  let protocol;
  {
    const vendor = join(work, 'cargo-vendor');
    const all = new Map();
    for (const item of [...requested.cargo, ...d.resources.worker_build_packages.map(p => ({...p, url: 'https://static.crates.io/crates/' + p.name + '/' + p.name + '-' + p.version + '.crate'}))]) {
      const key = item.name + '-' + item.version;
      if (all.has(key) && all.get(key).sha256 !== item.sha256) fail('Cargo同坐标原件摘要冲突');
      all.set(key, item);
    }
    await cargoView([...all.values()], vendor, options, tools);
    const config = '[source.crates-io]\nreplace-with = "locked"\n[source.locked]\ndirectory = ' + JSON.stringify(vendor) + '\n[net]\noffline = true\n';
    await writeFile(join(work, 'cargo-home/config.toml'), config, {flag: 'wx', mode: 0o444});
    const item = d.resources.tools['worker-build'], file = await original(item.platforms[requested.host], options, 'tool');
    const source = join(work, 'prepare/worker-build/source'), prefix = join(work, 'prepare/worker-build/payload');
    await materialize(await unpack(file.bytes, 'tar-gzip', options, tools), source, item.platforms[requested.host].root);
    if(digest(await readFile(join(source,'Cargo.lock')))!==d.resources.worker_build_lock_sha256)fail('worker-build锁定Cargo清单不一致');
    await runTool(tools.cargo, ['install', '--path', source, '--locked', '--offline', '--root', prefix],
      {work, tools, signal, environment: {CC: join(work, 'bin/cc'), AR: join(work, 'bin/ar'), OPENSSL_DIR: tools.opensslPrefix,
        OPENSSL_STATIC: '1', CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: join(work, 'bin/cc')}});
    if (unsafeWork.has(work)) fail('worker-build准备进程退出未确认');
    await rm(source, {recursive: true}); await normalizeLinks(prefix);
    tools['worker-build'] = join(prefix, 'bin/worker-build'); await closeCommands(work, {node:tools.node,sh: tools.sh, 'worker-build': tools['worker-build']});
    tools.esbuild = (await npmView(requested.npm, work, options, tools)).esbuild;
    await closeCommands(work,tools);
    // 协议仍使用build.rs消费的唯一回执。
    protocol = await prepare({work, mode, store: options.dependencyRoot, toolStore: options.toolRoot, offline: options.offline, signal, fetcher: options.fetcher ?? fetch});
    // build.rs逐字核对协议回执中的实际入口，不能传入准备前的工具库坐标。
    tools.protoc=protocol.protoc;
  }
  const environment = cleanEnvironment(work, tools, {...(protocol ? {TATACHAT_RESOURCE_RECEIPT: join(work, 'tatachat-protocol/receipt.json'), TATACHATSDK_PROTOCOL_DIR: protocol.protocol} : {}),
    ...(tools.opensslPrefix ? {OPENSSL_DIR: tools.opensslPrefix, OPENSSL_STATIC: '1', CC: join(work, 'bin/cc'), AR: join(work, 'bin/ar'),
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: join(work, 'bin/cc')} : {})});
  const receipt = {schema: 1, product_id: 'citizenserve', platform: 'cloudflare', flow, work, mode,...(options.runID?{run_id:options.runID}:{}),
    tools, environment};
  const path = join(work, 'resources.json');
  await writeFile(path, JSON.stringify(receipt) + '\n', {flag: 'wx', mode: 0o444});
  return receipt;
}
function assertWorkQuiescent(work) {
  if (unsafeWork.has(work)) fail('实际后代退出未确认，禁止清场');
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
// 可信Node直接展开已验真XZ，供Linux Runner物化锁定Zig原件。
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

return Object.freeze({flowDeclaration,assertWorkQuiescent,compileWorker,prepareFlowResources});
})();
const {flowDeclaration,assertWorkQuiescent,compileWorker,prepareFlowResources}=resourceRuntime;

// GitHub Runner调用产品公开编译入口，资源与编译由本仓准备。
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
  if (work!==join(base,'build/cloudflare')) fail('工作目录越界');
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
 const receipt=await prepareFlowResources({...options,flow:'build',work:request.work,runID:request.run_id}),path=join(request.work,'resources.json');
 return {schema:1,product_id:'citizenserve',platform:'cloudflare',flow:'build',work:request.work,run_id:request.run_id,mode:receipt.mode,receipt:path};
}

export async function claimBuildWork(runID,work){
 if(work!==join(root,'target/build/cloudflare')||typeof runID!=='string'||!/^[a-zA-Z0-9_-]{1,96}$/u.test(runID))fail('Build任务坐标无效');
 await directory(join(root,'target'));await directory(work);
 const lock=join(work,'.product-build.lock'),claim=join(root,'target/build/.claim-cloudflare');
 const marker={schema:1,product_id:'citizenserve',platform:'cloudflare',flow:'build',work,run_id:runID,pid:process.pid,nonce:randomUUID()};
 let stat;
 async function short(action){await mkdir(claim,{mode:0o700});const held=await lstat(claim);try{await writeFile(join(claim,'owner.json'),JSON.stringify({pid:process.pid,work})+'\n',{flag:'wx',mode:0o600});return await action();}finally{const now=await lstat(claim);if(now.dev!==held.dev||now.ino!==held.ino)fail('Build短锁漂移');await rm(claim,{recursive:true});}}
 async function owner(){const info=await lstat(lock),value=JSON.parse(await readFile(await checked(lock,'file')));if(info.dev!==stat.dev||info.ino!==stat.ino||Object.entries(marker).some(([key,v])=>value[key]!==v))fail('Build守卫或资源后代退出未确认');return value;}
 await short(async()=>{await assertWorkUnclaimed(work);await writeFile(lock,JSON.stringify(marker)+'\n',{flag:'wx',mode:0o600});stat=await lstat(lock);
  try{for(const name of await readdir(work))if(![basename(lock),basename(claim)].includes(name))await rm(join(work,name),{recursive:true,force:true});if((await readdir(work)).some(name=>![basename(lock),basename(claim)].includes(name)))fail('Build清空回读失败');}
  catch(error){await rm(lock);throw error;}});
 return {async finish(){assertWorkQuiescent(work);await short(async()=>{await owner();await rm(lock);for(const name of await readdir(work))await rm(join(work,name),{recursive:true,force:true});if((await readdir(work)).length)fail('Build收尾未清空');await rmdir(work);});}};
}

export async function buildOutputDigest(path){
 const info=await lstat(await checked(path,'file')),bytes=await bounded(path,256*1024**2);
 return digest(Buffer.concat([Buffer.from(JSON.stringify(['','file',Boolean(info.mode&0o111),bytes.length])+'\n'),bytes]));
}

export async function executeBuild(request,options={}){
 const {signal}=options,work=request?.work;
 const keys=['schema','product_id','platform','work','run_id','program_digest'];
 if(!request||Object.keys(request).some(x=>!keys.includes(x))||request.schema!==1||request.product_id!=='citizenserve'||request.platform!=='cloudflare'||request.program_digest!==undefined&&!/^[a-f0-9]{64}$/u.test(request.program_digest))fail('完整Build请求无效');
 if(process.platform!=='linux'||process.arch!=='x64')fail('Cloudflare Build只在GitHub Linux Runner执行');
 const guard=await claimBuildWork(request.run_id,work);
 try{
  const resources=await buildSupply(request,{...options,mode:'independent'});
  const receipt=await readBuildResource(resources,'cloudflare',work,signal);await compileWorker(receipt,signal);assertWorkQuiescent(work);
  const d=await flowDeclaration(),files=[];for(const name of d.platforms.cloudflare.files){if(!name.startsWith('worker/'))fail('Build输出声明漂移');const path=join(work,name);files.push({path,sha256:await buildOutputDigest(path)});}
  signal?.throwIfAborted();if(files.length!==2)fail('Build必须验真两件实际Worker输出');
  const result={schema:1,product_id:'citizenserve',platform:'cloudflare',work,run_id:request.run_id,completion:'compile-only',files};
  if(options.consume)await options.consume(result,receipt);return result;
 }finally{
  await guard.finish();
  // Runner消费两件输出后清空本次固定编译现场。
 }
}
