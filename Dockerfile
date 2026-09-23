FROM alibaba-cloud-linux-3-registry.cn-hangzhou.cr.aliyuncs.com/alinux3/python
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# 容器内固定端口（容器隔离，硬编码无妨），对外由 compose 映射
ENV PORT=8000
EXPOSE 8000
CMD ["python", "app.py"]
