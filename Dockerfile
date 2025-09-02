# Use the official Node.js runtime as the base image
FROM node:jod-alpine3.22

# Set the working directory inside the container
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Create a directory for the SQLite database
RUN mkdir -p /app/data

# Expose the port the app runs on
EXPOSE $PORT

# Define a volume for persistent data
VOLUME ["/app/data"]

# Define the command to run the application
CMD ["node", "index.js"]