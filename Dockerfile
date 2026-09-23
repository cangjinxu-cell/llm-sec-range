FROM ac2-registry.cn-hangzhou.cr.aliyuncs.com/ac2/base:alinux3.2104-py312
WORKDIR /app
COPY requirements.txt .
RUN python3 -m pip install --no-cache-dir -r requirements.txt
COPY . .
# 显式复制 modules 目录，确保其存在于镜像中
COPY modules ./modules
# 容器内固定端口（容器隔离，硬编码无妨），对外由 compose 映射
ENV PORT=8000
EXPOSE 8000
CMD ["python", "app.py"]
