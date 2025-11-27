terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 1.0"
    }
  }
}

variable "domain_name" {
  type = string
}

variable "zone_id" {
  type = string
}

resource "vercel_project" "web" {
  name      = "nostr-web"
  framework = "nextjs"

  git_repository = {
    type = "github"
    repo = "nisshiee/my-nostr-relay"
  }

  root_directory = "apps/web"
}

resource "vercel_project_domain" "web" {
  project_id = vercel_project.web.id
  domain     = var.domain_name
}

resource "aws_route53_record" "vercel" {
  name    = var.domain_name
  type    = "A"
  zone_id = var.zone_id
  ttl     = 60
  records = ["76.76.21.21"]
}
