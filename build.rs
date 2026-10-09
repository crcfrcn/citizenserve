//! 直接消费本产品显式供给的协议；构建阶段禁止联网、PATH寻找和邻仓读取。
use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn absolute(name: &str, directory: bool) -> PathBuf {
    let value =
        PathBuf::from(env::var_os(name).unwrap_or_else(|| panic!("缺少显式资源输入：{name}")));
    assert!(value.is_absolute(), "资源入口必须为绝对路径：{name}");
    for parent in value.ancestors() {
        let metadata = fs::symlink_metadata(parent).expect("资源路径不存在");
        assert!(!metadata.file_type().is_symlink(), "资源路径禁止链接");
    }
    assert_eq!(fs::canonicalize(&value).expect("规范资源路径"), value);
    let metadata = fs::metadata(&value).expect("读取资源类型");
    assert!(if directory {
        metadata.is_dir()
    } else {
        metadata.is_file()
    });
    value
}
// 产品工作根只允许固定build或test；Cargo内部输出仍由该工作根承载。
fn require_work_root(root: &Path, work: &Path) {
    assert!(
        work == root.join("target/build") || work == root.join("target/test"),
        "工作根必须为本产品target/build或target/test"
    );
}
fn main() {
    for name in [
        "PRODUCT_NODE_BIN",
        "PRODUCT_WORK_DIR",
        "CARGO_TARGET_DIR",
        "TATACHAT_RESOURCE_RECEIPT",
        "TATACHATSDK_PROTOCOL_DIR",
        "PROTOC",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-changed=scripts/flows.json");
    println!("cargo:rerun-if-changed=scripts/resources.mjs");
    let root = absolute("CARGO_MANIFEST_DIR", true);
    let work = absolute("PRODUCT_WORK_DIR", true);
    let target = absolute("CARGO_TARGET_DIR", true);
    require_work_root(&root, &work);
    assert_eq!(target, work.join("cargo-target"));
    let protocol = absolute("TATACHATSDK_PROTOCOL_DIR", true);
    let protoc = absolute("PROTOC", false);
    let receipt = absolute("TATACHAT_RESOURCE_RECEIPT", false);
    let out = absolute("OUT_DIR", true);
    assert!(out.starts_with(&target), "生成输出必须在本轮Cargo工作目录");
    let declaration: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("scripts/flows.json")).expect("读取唯一声明"))
            .expect("产品声明JSON");
    let files = declaration["tatachat"]["protocol"]["files"]
        .as_array()
        .expect("固定协议文件清单");
    let mut inputs = Vec::new();
    for file in files {
        let name = file["name"].as_str().expect("协议名称");
        assert!(!name.contains('/') && !name.contains('\\') && name.ends_with(".proto"));
        let path = protocol.join(name);
        assert!(fs::symlink_metadata(&path)
            .expect("协议存在")
            .file_type()
            .is_file());
        println!("cargo:rerun-if-changed={}", path.display());
        inputs.push(path);
    }
    println!("cargo:rerun-if-changed={}", protoc.display());
    println!("cargo:rerun-if-changed={}", receipt.display());
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc).out_dir(out.clone());
    config
        .compile_protos(&inputs, &[protocol])
        .expect("从唯一SDK协议生成Rust类型");
    assert!(
        out.join("chat.protocol.rs").is_file(),
        "实际Protobuf生成产物缺失"
    );
}
