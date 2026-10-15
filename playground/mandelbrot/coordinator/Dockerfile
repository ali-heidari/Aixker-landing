FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./

# Pass hub endpoints as arguments, e.g.
#   docker run IMAGE --hub-url http://hub:3000 --auth-url http://hub:16916
ENTRYPOINT ["python", "main.py"]
