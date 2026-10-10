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
// 产品工作根只允许平台编译现场或测试现场；Cargo内部输出仍由该工作根承载。
fn require_work_root(root: &Path, work: &Path) {
    assert!(
        work == root.join("target/build/cloudflare") || work == root.join("target/test"),
        "工作根必须为本产品target/build/cloudflare或target/test"
    );
}
fn main() {
    for name in [
        "PRODUCT_WORK_DIR",
        "CARGO_TARGET_DIR",
        "TATACHAT_RESOURCE_RECEIPT",
        "TATACHATSDK_PROTOCOL_DIR",
        "PROTOC",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
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
    // 协议需求由本产品Build准备器交付；Rust只消费当前任务的公开文件列表和工具路径。
    assert!(receipt.starts_with(&work), "协议回执必须归当前任务");
    let delivery: serde_json::Value =
        serde_json::from_slice(&fs::read(&receipt).expect("读取协议回执"))
            .expect("协议回执JSON");
    assert_eq!(delivery["schema"], 1);
    assert_eq!(delivery["product_id"], "citizenserve");
    assert_eq!(delivery["work"].as_str(), work.to_str());
    assert_eq!(delivery["protocol"].as_str(), protocol.to_str());
    assert_eq!(delivery["protoc"].as_str(), protoc.to_str());
    let files = delivery["files"]
        .as_array()
        .expect("本轮协议文件清单");
    assert!(!files.is_empty(), "协议文件清单为空");
    let mut names = std::collections::BTreeSet::new();
    let mut inputs = Vec::new();
    for file in files {
        let name = file.as_str().expect("协议名称");
        assert!(!name.contains('/') && !name.contains('\\') && name.ends_with(".proto"));
        assert!(names.insert(name.to_owned()), "协议名称重复");
        let path = protocol.join(name);
        assert!(fs::symlink_metadata(&path)
            .expect("协议存在")
            .file_type()
            .is_file());
        println!("cargo:rerun-if-changed={}", path.display());
        inputs.push(path);
    }
    let actual: std::collections::BTreeSet<_> = fs::read_dir(&protocol)
        .expect("读取本轮协议目录")
        .map(|item| item.expect("协议目录条目").file_name().into_string().expect("协议名称UTF-8"))
        .collect();
    assert_eq!(actual, names, "协议目录与本轮交付不符");
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
