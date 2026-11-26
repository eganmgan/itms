package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func serveOpenAPIV1(c *gin.Context) {
	paths := gin.H{}
	addPath := func(path string, methods ...string) {
		operations := gin.H{}
		for _, method := range methods {
			operation := gin.H{
				"responses": gin.H{
					"200": gin.H{"description": "Successful response"},
					"400": gin.H{"description": "Invalid request"},
					"401": gin.H{"description": "Authentication required"},
					"403": gin.H{"description": "Insufficient permissions"},
				},
			}
			if path != "/health" && path != "/openapi.json" && path != "/auth/login" && path != "/auth/refresh" && path != "/auth/forgot-password" && path != "/auth/reset-password" {
				operation["security"] = []gin.H{{"bearerAuth": []string{}}}
			}
			operations[method] = operation
		}
		paths[path] = operations
	}

	addPath("/health", "get")
	addPath("/openapi.json", "get")
	addPath("/auth/login", "post")
	addPath("/auth/logout", "post")
	addPath("/auth/refresh", "post")
	addPath("/auth/me", "get")
	addPath("/auth/forgot-password", "post")
	addPath("/auth/reset-password", "post")
	addPath("/users", "get", "post")
	addPath("/users/{id}", "get", "patch", "delete")
	addPath("/departments", "get", "post")
	addPath("/departments/{id}", "patch", "delete")
	addPath("/assets", "get", "post")
	addPath("/assets/{id}", "get", "patch", "delete")
	addPath("/me/assets", "get")
	addPath("/tickets", "get", "post")
	addPath("/tickets/{id}", "get")
	addPath("/tickets/{id}/status", "patch")
	addPath("/tickets/{id}/assign", "post")
	addPath("/tickets/{id}/comments", "post")
	addPath("/tickets/{id}/internal-notes", "get", "post")
	addPath("/tickets/{id}/attachments", "get", "post")
	addPath("/ticket-attachments/{id}", "get")
	addPath("/ticket-categories", "get", "post")
	addPath("/ticket-categories/{id}", "patch", "delete")
	addPath("/notifications", "get")
	addPath("/notifications/{id}/read", "patch")
	addPath("/notifications/read-all", "post")
	addPath("/reports/service-desk", "get")
	addPath("/audit", "get")
	addPath("/settings", "get", "put")

	c.JSON(http.StatusOK, gin.H{
		"openapi": "3.0.3",
		"info": gin.H{
			"title":       "ITMS REST API",
			"description": "Versioned service desk, inventory, authentication, and administration API.",
			"version":     "1.0.0",
		},
		"servers": []gin.H{{"url": "/api/v1"}},
		"paths":   paths,
		"components": gin.H{"securitySchemes": gin.H{
			"bearerAuth": gin.H{"type": "http", "scheme": "bearer", "bearerFormat": "JWT"},
			"refreshToken": gin.H{"type": "apiKey", "in": "cookie", "name": refreshCookieName},
		}},
	})
}